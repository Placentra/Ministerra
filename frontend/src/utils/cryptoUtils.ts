/** ----------------------------------------------------------------------------
 * CRYPTO UTILITIES
 * Device fingerprinting, password-derived keys, and SHA-256 hashing.
 * --------------------------------------------------------------------------- */

const PDK_ITERATIONS = 100000;
const PDK_KEY_LENGTH = 256;

// SHA-256 HASH GENERATOR -------------------------------------------------------
// Steps: pad message, expand words, run 64-round compression, then emit hex digest; used as a local primitive for fingerprints and HTTP fallback crypto paths.
export function hashGenerate(ascii) {
	function rRot(v, a) {
		return (v >>> a) | (v << (32 - a));
	}
	const maxWord = 2 ** 32,
		result = [],
		words = [],
		asciiBitLength = ascii.length * 8;
	let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const k = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	ascii += '\x80';
	while ((ascii.length % 64) - 56) ascii += '\x00';
	for (let i = 0; i < ascii.length; i++) words[i >> 2] |= ascii.charCodeAt(i) << (((3 - i) % 4) * 8);
	(words[words.length] = (asciiBitLength / maxWord) | 0), (words[words.length] = asciiBitLength);
	for (let j = 0; j < words.length; ) {
		const w = words.slice(j, (j += 16)),
			oldHash = hash.slice(0);
		for (let i = 0; i < 64; i++) {
			const [w15, w2, a, e] = [w[i - 15], w[i - 2], hash[0], hash[4]];
			const temp1 =
				hash[7] +
				(rRot(e, 6) ^ rRot(e, 11) ^ rRot(e, 25)) +
				((e & hash[5]) ^ (~e & hash[6])) +
				k[i] +
				(w[i] = i < 16 ? w[i] : (w[i - 16] + (rRot(w15, 7) ^ rRot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rRot(w2, 17) ^ rRot(w2, 19) ^ (w2 >>> 10))) | 0);
			const temp2 = (rRot(a, 2) ^ rRot(a, 13) ^ rRot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
			hash = [(temp1 + temp2) | 0].concat(hash);
			hash[4] = (hash[4] + temp1) | 0;
		}
		for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
	}
	for (let i = 0; i < 8; i++) for (let j = 3; j + 1; j--) result.push(((hash[i] >> (j * 8)) & 255).toString(16).padStart(2, '0'));
	return result.join('');
}

// GET DEVICE FINGERPRINT -------------------------------------------------------
// Steps: build a semi-stable device descriptor string (UA/screen/tz/lang/hardware), then hash it so we never persist raw fingerprint components.
export function getDeviceFingerprint() {
	const data = [
		navigator.userAgent || '',
		[window.screen.width, window.screen.height].join('x') || '',
		window.devicePixelRatio || 1,
		window.screen.colorDepth || 24,
		window.screen.pixelDepth || 24,
		Intl.DateTimeFormat().resolvedOptions().timeZone || '',
		new Date().getTimezoneOffset(),
		navigator.language || '',
		navigator.hardwareConcurrency || '',
		navigator.deviceMemory || '',
		navigator.maxTouchPoints || 0,
	].join(' | ');
	return hashGenerate(data);
}

// DERIVE KEY FROM PASSWORD (PBKDF2) --------------------------------------------
// Steps: prefer WebCrypto PBKDF2 in secure contexts; if unavailable (HTTP/testing), use a slow hash loop as a best-effort stand-in (NOT cryptographically equivalent).
export async function deriveKeyFromPassword(password, salt) {
	const encoder = new TextEncoder();
	if (crypto?.subtle) {
		const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
		const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: PDK_ITERATIONS, hash: 'SHA-256' }, keyMaterial, PDK_KEY_LENGTH);
		return btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
	}
	console.warn('Using insecure key derivation (HTTP context) - for testing only!');
	let derived = password + salt;
	for (let i = 0; i < 1000; i++) derived = hashGenerate(derived + salt + i);
	return btoa(derived.slice(0, 32));
}

// PDK SESSION STORAGE -----------------------------------------------------------
// Steps: keep PDK only in sessionStorage so it dies with the tab/session; forage worker can still encrypt it before persisting.
export function storePDK(pdk) {
	sessionStorage.setItem('_pdk', pdk);
}
export function getPDK() {
	return sessionStorage.getItem('_pdk');
}
export function clearPDK() {
	sessionStorage.removeItem('_pdk');
}
