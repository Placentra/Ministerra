/**
 * FORAGE SET WORKER - Local Storage with Multi-Layer Encryption (AES-GCM)
 *
 * Security layers:
 * 1. Device print - binds data to specific device hardware
 * 2. PDK (password-derived key) with per-device salt - requires password + device registration
 * 3. DEK (device encryption key) - backend-controlled, GDPR-compliant device-bound encryption
 * 4. Auth rotation - limits exposure window to 30 days
 * 5. AES-GCM authenticated encryption - detects tampering
 *
 * GDPR COMPLIANCE:
 * - DEK is generated/stored ONLY on backend - frontend NEVER sees key derivation
 * - Remote revocation: backend nullifies DEK → all device-bound data becomes unrecoverable
 * - Device change (fingerprint drift): backend returns null DEK → automatic data prune
 */

import localforage from 'localforage';

const delEveProps = ['own', 'inter', 'mark', 'awards', 'commsData', 'commsSyncedAt', 'cursors', 'userIDs', 'invited', 'invites', 'distance'],
	delUserProps = ['mark', 'awards', 'linked', 'trusts', 'note', 'message', 'unavail', 'distance'],
	needEncryption = new Set(['user', 'chat', 'comms', 'alerts', 'past']), // PDK-encrypted (user-bound)
	deviceBoundItems = new Set(['events', 'eve', 'users', 'use', 'miscel']), // DEK-encrypted (device-bound)
	unencryptedItems = new Set(['token']), // Stored unencrypted (token is already a signed JWT)
	isNotJSON = new Set(['token', 'auth']),
	itemKeys = { events: 'eve', users: 'use', chats: 'chat' };

let auth = null,
	userID = null,
	devicePrint = null,
	pdk = null,
	dek = null, // Device Encryption Key - backend-controlled, GDPR-compliant
	wipeMode = false;

// AES-GCM CRYPTO HELPERS ------------------------------------------------------------
// Steps: prefer WebCrypto AES-GCM; if unavailable (HTTP/testing), fall back to clearly-marked insecure helpers so dev environments still function.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hasSubtle = typeof crypto !== 'undefined' && crypto.subtle;

// SIMPLE HASH FOR HTTP FALLBACK (testing only) ---------------------------
const simpleHash = str => {
	let h = 0;
	for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
	return h.toString(16);
};

// XOR-BASED FALLBACK ENCRYPT/DECRYPT (testing only, NOT secure) ---------------------------
// TODO MAKE SURE PRODUCTION IS SET UP CORRECTLY REMOVING THIS
const xorCrypt = (text, key) => {
	let result = '';
	for (let i = 0; i < text.length; i++) result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
	return result;
};

// Derive a CryptoKey from a string password
// Steps: hash key material to fixed length, then import AES-GCM key; in HTTP fallback return raw string to feed xorCrypt path.
const deriveKey = async keyString => {
	if (!hasSubtle) return keyString; // HTTP fallback: return key as-is
	const keyData = encoder.encode(keyString);
	const hashBuffer = await crypto.subtle.digest('SHA-256', keyData);
	return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

// Encrypt with AES-GCM (returns base64: iv + ciphertext + auth tag)
// Steps: encrypt plaintext, prefix IV so decrypt can recover, then base64 encode so localforage stores a string.
const encryptGCM = async (keyString, plaintext) => {
	// HTTP FALLBACK (testing only) ---------------------------
	if (!hasSubtle) return btoa(xorCrypt(plaintext, keyString + simpleHash(keyString)));
	const key = await deriveKey(keyString);
	const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
	const data = encoder.encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return btoa(String.fromCharCode(...combined));
};

// Decrypt with AES-GCM (throws if tampered!)
// Steps: base64 decode, split IV+ciphertext, then decrypt; throws when auth tag fails (tampering/wrong key).
const decryptGCM = async (keyString, ciphertextB64) => {
	// HTTP FALLBACK (testing only) ---------------------------
	if (!hasSubtle) return xorCrypt(atob(ciphertextB64), keyString + simpleHash(keyString));
	const key = await deriveKey(keyString);
	const combined = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
	const iv = combined.slice(0, 12);
	const ciphertext = combined.slice(12);
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
	return decoder.decode(plaintext);
};

// PDK STORAGE - encrypted with device print in IndexedDB ---------------------------
const PDK_KEY = '_encPDK';
const storePDKEncrypted = async (pdkValue, print) => {
	await localforage.setItem(PDK_KEY, await encryptGCM(print, pdkValue));
};
const loadPDKEncrypted = async print => {
	const encrypted = await localforage.getItem(PDK_KEY);
	if (!encrypted) return null;
	try {
		return await decryptGCM(print, encrypted);
	} catch {
		return null;
	} // Tampered or wrong key
};
const clearPDKEncrypted = () => localforage.removeItem(PDK_KEY);

// DEK STORAGE - backend-controlled device encryption key, encrypted with device print ---------------------------
// GDPR: DEK never derived on frontend - backend generates/stores/revokes it
const DEK_KEY = '_encDEK';
const storeDEKEncrypted = async (dekValue, print) => {
	await localforage.setItem(DEK_KEY, await encryptGCM(print, dekValue));
};
const loadDEKEncrypted = async print => {
	const encrypted = await localforage.getItem(DEK_KEY);
	if (!encrypted) return null;
	try {
		return await decryptGCM(print, encrypted);
	} catch {
		return null;
	} // Tampered or wrong key
};
const clearDEKEncrypted = () => localforage.removeItem(DEK_KEY);

// PRUNE ALL DEVICE-BOUND DATA - called when DEK is null (device revoked or deviceID changed) ---------------------------
const pruneDeviceBoundData = async () => {
	const keys = await localforage.keys();
	const deviceBoundPrefixes = ['eve_', 'use_', 'miscel', 'token', 'printHash', DEK_KEY];
	for (const key of keys) if (deviceBoundPrefixes.some(prefix => key.startsWith(prefix)) || key === 'miscel' || key === 'token') await localforage.removeItem(key);
	dek = null;
};

// COMBINE KEYS - print + pdk for stronger encryption
// Steps: require both print and PDK, then concatenate to derive a combined key used to decrypt the auth hash used for user-bound storage.
const getCombinedKey = () => {
	if (!devicePrint) throw new Error('noPrint');
	if (!pdk) throw new Error('noPDK');
	return devicePrint + ':' + pdk;
};

// GET ENCRYPTION KEY ----------------------------------------------------------------
// Steps: decide which key applies to this “what” bucket (unencrypted/auth/user-bound/device-bound), return null for “store as-is”.
const getKey = async what => {
	// UNENCRYPTED ITEMS (token is already a signed JWT) ---------------------------
	if (unencryptedItems.has(what)) return null;

	// AUTH STORAGE - encrypted with combined key (print + pdk) ---------------------------
	if (what === 'auth') return getCombinedKey();

	// USER-BOUND DATA (needsEncrypt) - encrypted with auth hash derived from PDK ---------------------------
	if (needEncryption.has(what)) {
		if (!auth || !devicePrint || !pdk) return null;
		try {
			return await decryptGCM(getCombinedKey(), auth);
		} catch {
			return null;
		}
	}

	// DEVICE-BOUND DATA - encrypted with DEK (backend-controlled, GDPR-compliant) ---------------------------
	if (deviceBoundItems.has(what)) {
		if (!dek) return null;
		return dek;
	}

	return null; // Unknown items - no key
};

// ENCRYPT / DECRYPT with AES-GCM ----------------------------------------------------
// Steps: stringify objects deterministically, then encrypt with selected key; decrypt reverses and JSON-parses when appropriate.
const encrypt = async (what, data) => {
	const key = await getKey(what);
	const plaintext = typeof data === 'object' ? JSON.stringify(data) : data.toString();
	if (!key) return plaintext; // Unencrypted items stored as-is
	return encryptGCM(key, plaintext);
};

const decrypt = async (what, data) => {
	try {
		const key = await getKey(what);
		if (!key) return isNotJSON.has(what) ? data : JSON.parse(data || '{}'); // Unencrypted items
		const decrypted = await decryptGCM(key, data);
		return isNotJSON.has(what) ? decrypted : JSON.parse(decrypted || '{}');
	} catch (error) {
		console.error('Decrypt error:', what, error.message);
		return null;
	}
};

// TRIM CURSORS ----------------------------------------------------------------------
// Steps: trim chat/alerts/comms arrays to cursor windows so persisted payload stays bounded while still keeping “own recent” messages for UX.
const trimAfterCursor = (data, cursors, syncedAt) => {
	if (!data) return [];
	if (cursors === 'gotAll') return data;
	return data.filter(
		({ id, own, created }) =>
			id >= cursors[1] ||
			(cursors.recent && id >= (cursors.recent[0] !== 'new' ? cursors.recent[2] : cursors.recent[1])) ||
			(cursors.oldest && id <= (cursors.oldest[0] !== 'old' ? cursors.oldest[2] : cursors.oldest[1])) ||
			(own && created > syncedAt)
	);
};

// DELETE SENSITIVE PROPS ------------------------------------------------------------
// Steps: strip user-specific overlays before persisting shared entities so device storage remains privacy-safe and smaller (own/inter/marks/etc are stored in user-bound buckets).
const deleteSensitiveProps = (what, val) => {
	const props = ['events', 'eve'].includes(what) ? delEveProps : ['users', 'use'].includes(what) ? delUserProps : [];
	if (props.length) for (const item of val) for (const prop of props) delete item[prop];
	return val;
};

// RE-ENCRYPT DURING ROTATION --------------------------------------------------------
// Steps: when auth epoch rotates, decrypt old user-bound buckets with old hash and re-encrypt with new hash; on failure, caller clears stale buckets to avoid partial corruption.
const reEncryptStores = async (oldAuthHash, newAuthHash) => {
	if (!userID) return;
	const allKeys = await localforage.keys();

	for (const storeType of needEncryption) {
		const keys = allKeys.filter(k => k.startsWith(`${userID}_${storeType}`));
		for (const key of keys) {
			try {
				const encrypted = await localforage.getItem(key);
				if (!encrypted) continue;
				const decrypted = await decryptGCM(oldAuthHash, encrypted);
				if (decrypted) await localforage.setItem(key, await encryptGCM(newAuthHash, decrypted));
			} catch (e) {
				console.error(`Re-encrypt failed for ${key}:`, e.message);
				throw e; // Propagate to trigger data cleanup
			}
		}
	}
};

// STORAGE KEY HELPER ----------------------------------------------------------------
// Steps: build stable per-user keys for user-bound buckets and stable global keys for device-bound buckets; itemKeys normalizes plural buckets to per-item prefixes.
const getStorageKey = (what, itemId) => {
	const base = needEncryption.has(what) ? `${userID}_${what}` : itemKeys[what] || what;
	return `${base}${itemId ? `_${itemId}` : ''}`;
};

// MAIN WORKER HANDLER ---------------------------------------------------------------
// Steps: accept requests from UI thread, enforce wipe mode, enforce key availability, then perform get/set/del with encrypt/decrypt and respond with reqId correlation.
self.addEventListener('message', async ({ data: { mode, what, id, val, reqId } }) => {
	const respond = payload => self.postMessage({ ...payload, reqId });
	if (mode === 'init') return self.postMessage({ inited: true });
	if (mode === 'wipe') return (wipeMode = Boolean(val)), respond({ data: wipeMode });
	if (mode === 'clearPDK') return await clearPDKEncrypted(), (pdk = null), respond({ data: true });
	if (mode === 'clearDEK') return await pruneDeviceBoundData(), respond({ data: true });
	if (mode === 'status') {
		const keys = await localforage.keys();
		return respond({
			data: { keysCount: keys.length, hasDEK: Boolean(dek), hasPDK: Boolean(pdk), hasUserData: keys.some(k => /^eve_|^use_|^\d+_(user|chat|comms|alerts|past)/.test(k) || k === 'miscel') },
		});
	}

	if (needEncryption.has(what) && !auth) return respond({ data: null });
	if (deviceBoundItems.has(what) && !dek && what !== 'auth') return respond({ data: null }); // DEK required for device-bound items

	let data;
	try {
		// GET ---------------------------------------------------------------------------
		if (mode === 'get') {
			if (what === 'auth') data = auth;
			else if (what === 'past' && !id) {
				data = {};
				for (const key of await localforage.keys())
					if (key.startsWith(getStorageKey('past', ''))) {
						const item = await localforage.getItem(key);
						if (item) data[key.split('_')[2]] = await decrypt('past', item);
					}
			} else if (Array.isArray(id)) {
				data = [];
				for (let i = 0; i < id.length; i += 100) {
					const batch = await Promise.all(
						id.slice(i, i + 100).map(async itemId => {
							const item = await localforage.getItem(getStorageKey(what, itemId));
							return item ? await decrypt(what, item) : null;
						})
					);
					data.push(...batch.filter(Boolean));
				}
			} else {
				const item = await localforage.getItem(getStorageKey(what, id));
				if (item) data = await decrypt(what, item);
			}

			// SET ---------------------------------------------------------------------------
		} else if (mode === 'set') {
			if (wipeMode) return respond({ data: null });

			if (what === 'auth') {
				userID = id;

				// Object format: { auth, print, pdk?, deviceKey?, deviceSalt?, epoch, prevAuth? }
				if (typeof val === 'object' && val.print) {
					const { auth: authStr, print, pdk: newPdk, deviceKey: newDek, deviceSalt, epoch, prevAuth } = val;
					const newAuthHash = authStr.split(':')[1];
					devicePrint = print;

					// PDK HANDLING: use provided PDK (login) or load from encrypted storage (refresh) ---------------------------
					if (newPdk) (pdk = newPdk), await storePDKEncrypted(newPdk, print);
					else if (((pdk = await loadPDKEncrypted(print)), !pdk)) return respond({ error: 'noPDK' }); // Session expired

					// DEK HANDLING: backend-controlled device encryption key (GDPR-compliant) ---------------------------
					if (newDek) (dek = newDek), await storeDEKEncrypted(newDek, print); // Login: store new DEK
					else if (newDek === null) {
						// DEVICE REVOKED or deviceID changed: prune all device-bound data ---------------------------
						console.warn('DEK null from backend - device revoked or deviceID changed, pruning device-bound data');
						await pruneDeviceBoundData();
						respond({ status: 'device_revoked' });
					} else {
						// Refresh: load DEK from encrypted storage ---------------------------
						dek = await loadDEKEncrypted(print);
						if (!dek) console.warn('DEK not found in storage - device-bound data will be unavailable');
					}

					const combinedKey = getCombinedKey();

					// AUTH ROTATION: re-encrypt user-bound data if epoch changed ---------------------------
					if (prevAuth) {
						const oldAuthHash = prevAuth.split(':')[1];
						const userKeys = (await localforage.keys()).filter(k => k.startsWith(`${id}_`) && needEncryption.has(k.split('_')[1]));
						if (userKeys.length > 0) {
							respond({ status: 'reencrypting', count: userKeys.length });
							try {
								await reEncryptStores(oldAuthHash, newAuthHash), respond({ status: 'reencrypted' });
							} catch (e) {
								console.warn('Re-encryption failed, clearing stale data:', e.message);
								for (const key of userKeys) await localforage.removeItem(key);
								respond({ status: 'cleared_stale' });
							}
						}
					}

					auth = await encryptGCM(combinedKey, newAuthHash);
					await localforage.setItem('authEpoch', epoch);
					// Store print hash for integrity check ---------------------------
					let printHashHex;
					if (hasSubtle) {
						const printHashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(print));
						printHashHex = Array.from(new Uint8Array(printHashBuffer))
							.map(b => b.toString(16).padStart(2, '0'))
							.join('')
							.slice(0, 16);
					} else printHashHex = simpleHash(print + print).slice(0, 16); // HTTP fallback
					await localforage.setItem('printHash', printHashHex);
				} else {
					// Legacy fallback - should not happen in normal flow ---------------------------
					console.warn('Legacy auth format received - this should not happen');
					return respond({ error: 'invalidAuthFormat' });
				}
			} else {
				data = ['events', 'eve', 'users', 'use'].includes(what) ? deleteSensitiveProps(what, Array.isArray(val) ? val : [val]) : val;

				if (what === 'user') {
					['blocks', 'requests'].forEach(cat => (delete data.galleryIDs?.[cat], delete data.noMore?.gallery?.[cat]));
					['alerts', 'pastEve'].forEach(prop => delete data[prop]);
				} else if (what === 'chat') data.messages = trimAfterCursor(data.messages, data.cursors);
				else if (what === 'alerts') data.data = trimAfterCursor(data.data, data.cursors);
				else if (what === 'comms' && data.commsData?.length) {
					data.commsData = trimAfterCursor(data.commsData, data.cursors, data.commsSyncedAt);
					for (const c of data.commsData) if (c.repliesData?.length) c.repliesData = trimAfterCursor(c.repliesData, c.cursors, c.repliesSyncedAt);
				}

				const store = async (itemId, itemData) => localforage.setItem(getStorageKey(what, itemId), await encrypt(what, itemData));
				if (Array.isArray(data)) for (const item of data) await store(item.id, item);
				else await store(id, data);
			}

			// DEL ---------------------------------------------------------------------------
		} else if (mode === 'del') {
			if (what === 'everything') {
				await localforage.clear();
				auth = userID = devicePrint = pdk = dek = null;
			} else if (what === 'user') {
				for (const key of (await localforage.keys()).filter(k => k.startsWith(userID))) await localforage.removeItem(key);
				await clearPDKEncrypted(); // Clear encrypted PDK on logout
				await clearDEKEncrypted(); // Clear encrypted DEK on logout
				auth = userID = pdk = dek = null;
			} else {
				const ids = Array.isArray(id) ? id : [id];
				for (const itemId of ids) await localforage.removeItem(getStorageKey(what, itemId));
			}
		}

		if (needEncryption.has(what)) await localforage.setItem(`${userID}_Last`, Date.now());
		respond({ data });
	} catch (error) {
		console.error('ForageWorker error:', error);
		respond({ error: error.message });
	}
});
