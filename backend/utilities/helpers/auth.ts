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

// VERIFY AUTH TOKEN ------------------------------------------------------------
// Steps: validate against current epoch first (fast success), then allow previous epoch during grace window so in-flight clients
// can rotate safely; use timingSafeEqual to avoid leaking correctness via timing.
export function verifyAuth(userID: string | number, providedHash: string, providedEpoch: number): VerifyAuthResult {
	const now: number = Date.now();

	const currentEpoch: number = Math.floor(now / (INTERVALS.authRotation || 3600000));
	const generateHash = (uid: string | number, ep: number): string => crypto.createHmac('sha256', process.env.AUTH_CRYPTER as string).update(`${uid}:${ep}`).digest('hex');

	// Check current epoch first ---------------------------
	if (providedEpoch === currentEpoch) {
		const expectedHash: string = generateHash(userID, currentEpoch);
		// timingSafeEqual requires Buffers of equal length
		const providedBuffer: Buffer = Buffer.from(providedHash);
		const expectedBuffer: Buffer = Buffer.from(expectedHash);

		if (providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
			return { valid: true, expired: false, epoch: currentEpoch };
		}
	}

	// Allow previous epoch during grace period ---------------------------
	const prevEpoch: number = currentEpoch - 1;
	if (providedEpoch === prevEpoch) {
		const expectedHash: string = generateHash(userID, prevEpoch);
		const providedBuffer: Buffer = Buffer.from(providedHash);
		const expectedBuffer: Buffer = Buffer.from(expectedHash);

		if (providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
			return { valid: true, expired: true, epoch: prevEpoch, needsRotation: true };
		}
	}
	return { valid: false };
}
