import { forage, getDeviceFingerprint } from '../../helpers';

// GET TOKEN (AUTH + EXPIRY) ---------------------------------------------------
// Steps: read stored token string (sessionStorage for authToken, IndexedDB for normal token), split into fields, compute expiry, then only compute fingerprint when expired so we avoid unnecessary entropy work.
export async function getToken(getAuthToken = false) {
	let token, expiry, print;
	// STORAGE READ -------------------------------------------------------------
	// Steps: pick the correct storage based on getAuthToken because authToken is session-scoped while token is persisted for normal navigation.
	const storedStr = getAuthToken ? sessionStorage.getItem('authToken') : await forage({ mode: 'get', what: 'token' });
	const parts = (storedStr || '').split(':');
	[token, expiry] = parts;

	// EXPIRY CHECK -------------------------------------------------------------
	// Steps: compute expired flag from expiry timestamp; if expired, compute print so refresh endpoints can re-bind session to device.
	const isExpired = expiry ? Date.now() >= Number(expiry) : false;
	// MISSING AUTH TOKEN ---
	// Steps: when getAuthToken=true but no token exists, mark as missing (not just expired) so callers don't attempt invalid refresh.
	const isMissing = getAuthToken && !token;
	if (isExpired && navigator.onLine) print = getDeviceFingerprint();
	return { token, expiry: Number(expiry) || null, print, expired: isExpired, missing: isMissing };
}
