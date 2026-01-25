// AUTHENTICATION HELPERS =======================================================
// Time-based rotating auth tokens for frontend encryption key derivation used in foundation loaders

import crypto from 'crypto';
import { INTERVALS } from '../../../shared/constants.ts';

interface AuthPayload {
	auth: string;
	epoch: number;
	expiry: number;
	previousAuth?: string;
	previousEpoch?: number;
}

interface AuthOptions {
	clientEpoch?: number;
}

// GET AUTH TOKEN PAYLOAD -------------------------------------------------------
// Steps: compute current epoch from rotation interval, derive HMAC for that epoch, and optionally include a previous-epoch auth
// when the client reports it is behind so the client can re-encrypt without a hard failure.
export function getAuth(userID: string | number, options: AuthOptions = {}): AuthPayload {
	const now: number = Date.now();

	const currentEpoch: number = Math.floor(now / (INTERVALS.authRotation || 3600000));
	const generateHash = (uid: string | number, ep: number): string => crypto.createHmac('sha256', process.env.AUTH_CRYPTER as string).update(`${uid}:${ep}`).digest('hex');

	// If client is behind current epoch, include previous auth for re-encryption ---------------------------
	const clientEpoch: number | undefined = options?.clientEpoch;
	return clientEpoch !== undefined && clientEpoch < currentEpoch
		? {
				auth: `${userID}:${generateHash(userID, currentEpoch)}`,
				epoch: currentEpoch,
				expiry: (currentEpoch + 1) * (INTERVALS.authRotation || 3600000),
				previousAuth: `${userID}:${generateHash(userID, clientEpoch)}`,
				previousEpoch: clientEpoch,
		  }
		: {
				auth: `${userID}:${generateHash(userID, currentEpoch)}`,
				epoch: currentEpoch,
				expiry: (currentEpoch + 1) * (INTERVALS.authRotation || 3600000),
		  };
}

interface VerifyAuthResult {
	valid: boolean;
	expired?: boolean;
	epoch?: number;
	needsRotation?: boolean;
}

// CONSTANT-TIME HASH COMPARE ---------------------------------------------------
// Steps: pad both buffers to fixed 64 bytes (SHA256 hex output length) so length check doesn't leak timing info, then use timingSafeEqual.
const HASH_LENGTH = 64; // SHA256 hex output is always 64 chars
function constantTimeHashCompare(provided: string, expected: string): boolean {
	// PAD TO FIXED LENGTH ---
	// Steps: normalize to fixed length so timing is uniform regardless of input length.
	const providedPadded: Buffer = Buffer.alloc(HASH_LENGTH);
	const expectedPadded: Buffer = Buffer.alloc(HASH_LENGTH);
	Buffer.from(provided).copy(providedPadded);
	Buffer.from(expected).copy(expectedPadded);
	// LENGTH MUST MATCH FOR VALID COMPARISON ---
	// Steps: if provided length differs from expected, the padded comparison will fail but timing is constant.
	return provided.length === expected.length && crypto.timingSafeEqual(providedPadded, expectedPadded);
}

// VERIFY AUTH TOKEN ------------------------------------------------------------
// Steps: validate against current epoch first (fast success), then allow previous epoch during grace window so in-flight clients
// can rotate safely; use constantTimeHashCompare to avoid leaking correctness via timing.
export function verifyAuth(userID: string | number, providedHash: string, providedEpoch: number): VerifyAuthResult {
	const now: number = Date.now();

	const currentEpoch: number = Math.floor(now / (INTERVALS.authRotation || 3600000));
	const generateHash = (uid: string | number, ep: number): string => crypto.createHmac('sha256', process.env.AUTH_CRYPTER as string).update(`${uid}:${ep}`).digest('hex');

	// Check current epoch first ---------------------------
	if (providedEpoch === currentEpoch) {
		const expectedHash: string = generateHash(userID, currentEpoch);
		if (constantTimeHashCompare(providedHash, expectedHash)) {
			return { valid: true, expired: false, epoch: currentEpoch };
		}
	}

	// Allow previous epoch during grace period ---------------------------
	const prevEpoch: number = currentEpoch - 1;
	if (providedEpoch === prevEpoch) {
		const expectedHash: string = generateHash(userID, prevEpoch);
		if (constantTimeHashCompare(providedHash, expectedHash)) {
			return { valid: true, expired: true, epoch: prevEpoch, needsRotation: true };
		}
	}
	return { valid: false };
}
