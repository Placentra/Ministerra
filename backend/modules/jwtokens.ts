import JWT from 'jsonwebtoken';
import { Sql, Catcher } from '../systems/systems.ts';
import crypto from 'crypto';
import { getLogger } from '../systems/handlers/loggers.ts';
import { LRUCache } from 'lru-cache';
import { EXPIRATIONS, REDIS_KEYS } from '../../shared/constants.ts';

let redis: any;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Injects the shared redis client for refresh token persistence and revocation checks.
const ioRedisSetter = (redisClient: any): any => (redis = redisClient);
const logger = getLogger('JWTokens');
const ONE_WEEK_MS: number = 7 * 24 * 60 * 60 * 1000;

interface JWTPayload {
	userID: string | number;
	devID: string;
	is: string;
	iat: number;
	exp?: number;
	logins?: number;
	lastLogin?: number;
}

// JWT VERIFICATION CACHE ------------------------------------------------------
// Avoids re-verifying same token repeatedly. Stores decoded payload keyed by token string.
// Reduces CPU overhead for frequently accessed endpoints.
const jwtCache: LRUCache<string, JWTPayload> = new LRUCache<string, JWTPayload>({
	max: 10000, // 10k active tokens per worker
	ttl: 20 * 60 * 1000, // 20 minutes max (matches ACCESS token life)
	updateAgeOnGet: true, // Keep hot tokens cached
	updateAgeOnHas: false,
});

// INVALIDATE CACHE FOR DEVICE --------------------------------------------------
// Called when a user logs out or a device is revoked to ensure immediate effect.
// This prevents stale cached JWT payloads from keeping access alive after revocation.
// Steps: scan jwtCache entries, match by (userID,devID), delete matching tokens so subsequent requests are forced down the verify path.
function invalidateCacheForDevice(userID: string | number, devID: string): void {
	for (const [token, decoded] of (jwtCache as any).entries()) {
		if (decoded.userID === userID && decoded.devID === devID) {
			jwtCache.delete(token);
		}
	}
}

// TOKEN CONFIGURATION ---------------------------------------------------------
const TOKEN_EXPIRY: Record<string, string> = {
	ACCESS: '20m',
	REFRESH: '7d',
	AUTH: '5m',
};

// HELPER: DYNAMIC SECRET GENERATION --------------------------------------------
// Generates a time-based secret key for Refresh Tokens.
// Rotates every hour based on iat to reduce blast radius if a secret is ever compromised.
// Steps: compute hour slot from iat, derive HMAC(userID:slot) so refresh signature rotates predictably without storing per-token secrets.
function getDynamicSecret(userID: string | number, secretBase: string, iat: number): string {
	const iatMs: number = iat * 1000;
	const hourSlot: number = Math.floor(iatMs / 3600000); // 1-hour slots
	return crypto.createHmac('sha256', secretBase).update(`${userID}:${hourSlot}`).digest('hex');
}

// HELPER: DEVICE ID DERIVATION -------------------------------------------------
// Hashes the browser fingerprint (print) to derive a stable, anonymized device ID.
// This avoids storing raw fingerprint values as primary identifiers.
// Steps: use fallback devID when provided (already derived), otherwise require print and sha1(userID:print) to get a compact stable device id.
function deriveDeviceId(userID: string | number, print: string | undefined, fallbackDevId?: string): string {
	if (fallbackDevId) return fallbackDevId;
	if (!print) throw new Error('missingDeviceFingerprint');
	return crypto.createHash('sha1').update(`${userID}:${print}`).digest('hex').slice(0, 12);
}

// HELPER: COOKIE OPTIONS -------------------------------------------------------
// Returns cookie options for the signed refresh token cookie:
// - httpOnly + signed to reduce JS exfil/tampering risk
// - secure/sameSite controlled via env with safe defaults for prod
// Steps: compute secure/sameSite defaults from env, attach maxAge/httpOnly/signed, optionally set domain, return options for res.cookie().
function getRefreshCookieOptions(): any {
	const env: string = (process.env.NODE_ENV || '').toLowerCase();
	const secureEnv: string = (process.env.COOKIE_SECURE || '').toLowerCase();
	const secure: boolean = secureEnv === 'true' || secureEnv === '1' ? true : secureEnv === 'false' || secureEnv === '0' ? false : env === 'production';
	const sameSite: 'strict' | 'lax' | 'none' = (process.env.COOKIE_SAMESITE as any) || (secure ? 'strict' : 'lax');
	const cookieOptions: any = {
		maxAge: ONE_WEEK_MS,
		httpOnly: true, // Prevent JS access to refresh token
		signed: true, // Detect tampering
		secure, // HTTPS only in prod
		sameSite, // CSRF protection
		path: '/',
	};
	const cookieDomain: string | undefined = process.env.COOKIE_DOMAIN;
	if (cookieDomain) cookieOptions.domain = cookieDomain;
	return cookieOptions;
}

// TOKEN HANDLERS --------------------------------------------------------------

interface JwtCreateProps {
	res: any;
	con?: any;
	create: 'both' | 'access' | 'refresh';
	userID: string | number;
	is: string;
	print?: string;
	deviceInfo?: any;
	expiredAt?: number | null;
}

/** ----------------------------------------------------------------------------
 * JWT CREATE
 * Generates Access and Refresh tokens, handles device tracking, and sets cookies.
 * Steps: derive devID, optionally rotate/persist refresh token (SQL+Redis+cookie), always issue aJWT with expiry header, and embed small device heuristics for the client.
 *
 * @param {Object} context - { res, con, create, userID, is, print, deviceInfo, expiredAt }
 * @param {string} create - 'both' (login/refresh) or 'access' (just aJWT renewal)
 * -------------------------------------------------------------------------- */
async function jwtCreate({ res, con, create, userID, is, print, deviceInfo = {}, expiredAt = null }: JwtCreateProps): Promise<any> {
	if (!redis) throw new Error('Redis client not initialized');
	try {
		// SESSION COORDINATES ---------------------------------------------------
		// iat is computed once so both tokens share the same issued-at reference.
		const now: number = Date.now();
		const iat: number = Math.floor(now / 1000); // Calculate iat once and reuse for both tokens
		let { logins = 1, lastLogin, devID: previousDevId } = deviceInfo;
		const devID: string = deriveDeviceId(userID, print, previousDevId);

		// LOGIN FREQUENCY TRACKING --------------------------------------------
		// Tracks how often this specific device logs in.
		// Used to determine "stable" devices vs new/infrequent ones.
		if (expiredAt) {
			const daysSinceExpiry: number = Math.floor((now - expiredAt) / (1000 * 60 * 60 * 24));
			if (daysSinceExpiry > 7) {
				if (deviceInfo.logins === undefined && daysSinceExpiry > 90) logins = 1;
			} else {
				const today: string = new Date().toDateString();
				const lastDate: string | null = lastLogin ? new Date(lastLogin).toDateString() : null;
				if (!lastLogin || today !== lastDate) logins += 1;
			}
		}
		lastLogin = now;

		// REFRESH TOKEN (rJWT) GENERATION -------------------------------------
		if (create === 'both' || create === 'refresh') {
			const refreshPayload: any = { userID, iat };
			const dynamicSecret: string = getDynamicSecret(userID, process.env.RJWT_SECRET as string, iat);
			const rJWT: string = (JWT.sign as any)(refreshPayload, dynamicSecret, { expiresIn: `${TOKEN_EXPIRY.REFRESH}` });

			const isLocalCon: boolean = !con;
			con = con || (await Sql.getConnection());
			try {
				// Clean up old device entry if ID changed (e.g. fingerprint evolved)
				if (previousDevId && previousDevId !== devID)
					await Promise.all([
						con.execute('DELETE FROM rjwt_tokens WHERE user = ? AND device = ?', [userID, previousDevId]),
						redis.hdel(REDIS_KEYS.refreshTokens, `${userID}_${previousDevId}`),
					]);

				// Persist new refresh token to SQL and Redis
				await Promise.all([
					con.execute(
						`INSERT INTO rjwt_tokens (user, device, token, print) VALUES (?, ?, ?, ?)
						ON DUPLICATE KEY UPDATE token = VALUES(token), print = VALUES(print)`,
						[userID, devID, rJWT, print]
					),
					redis.hset(REDIS_KEYS.refreshTokens, `${userID}_${devID}`, `${rJWT}:${print}`),
				]);

				res.cookie('rJWT', rJWT, getRefreshCookieOptions());
			} finally {
				if (isLocalCon && con) con.release();
			}
		}

		// ACCESS TOKEN (aJWT) GENERATION --------------------------------------
		// Short-lived token for API authorization.
		const expiryMatch: RegExpMatchArray | null = (EXPIRATIONS.accessToken as string).match(/^(\d+)([smhd])$/);
		const num: number = Number(expiryMatch?.[1] ?? 20);
		const unit: string = expiryMatch?.[2] ?? 'm';
		const multiplier: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
		const expiry: number = Date.now() + num * (multiplier[unit] || 60000);

		const accessPayload: any = { userID, is, devID, iat };
		// Embed login stats for client-side heuristics (e.g., showing onboarding tips)
		if (logins < 4) {
			accessPayload.logins = logins;
			accessPayload.lastLogin = lastLogin;
		}
		const aJWT: string = (JWT.sign as any)(accessPayload, process.env.AJWT_SECRET as string, { expiresIn: `${EXPIRATIONS.accessToken}` });
		res.set('Authorization', `Bearer ${aJWT}:${expiry}`);
	} catch (error) {
		logger.error('jwtCreate', { error, userID, create });
		if (!res) throw new Error('unauthorized - can´t create token through SOCKET');
		else return Catcher({ origin: 'jwtCreate', error, res });
	}
}

/** ----------------------------------------------------------------------------
 * REFRESH ACCESS TOKEN SESSION
 * Handles the logic when an Access Token expires.
 * Validates the Refresh Token from cookie against Redis and Device Fingerprint.
 * If valid, issues a new Access Token (and potentially rotates Refresh Token).
 * Steps: validate cookie, decode both tokens, verify same session coordinates, verify refresh token matches redis, verify fingerprint, then mint aJWT (and rotate rJWT when rJWT expired).
 * -------------------------------------------------------------------------- */
async function refreshAccessToken(req: any, res: any, accessToken: string, expiredError: any): Promise<any> {
	const refreshToken: string | undefined = req.signedCookies.rJWT;

	// COOKIE + BASIC VALIDATION --------------------------------------------
	// Steps: require signed refresh cookie; if missing, force logout so client clears state and re-auths.
	if (!refreshToken) {
		const rawCookie: string | undefined = req.cookies?.rJWT;
		logger.error('refreshToken missing', { signedValue: refreshToken, rawCookie: rawCookie ? 'present' : 'absent', cookieHeader: req.headers.cookie ? 'present' : 'absent' });
		throw new Error('logout');
	}

	// DECODE ---------------------------------------------------------------
	// Steps: decode both tokens to cross-check user/dev coordinates before spending CPU on signature verification.
	const accessDecoded: JWTPayload = JWT.decode(accessToken) as JWTPayload;
	const refreshDecoded: JWTPayload = JWT.decode(refreshToken) as JWTPayload;

	// SESSION COORD CHECK ---------------------------------------------------
	// Steps: require both decodes; if refresh decode has enough info, revoke cached redis refresh entry and force logout.
	if (!refreshDecoded || !accessDecoded) {
		if (refreshDecoded?.userID && (refreshDecoded as any).devID) await redis.hdel(REDIS_KEYS.refreshTokens, `${refreshDecoded.userID}_${(refreshDecoded as any).devID}`);
		throw new Error('logout');
	}

	const { userID, devID, is, iat: accessIat } = accessDecoded;
	const { userID: refreshUserID, iat: refreshIat } = refreshDecoded;

	// IAT ORDERING ----------------------------------------------------------
	// Steps: reject when aJWT predates rJWT iat or when userIDs differ; prevents mixing tokens across sessions.
	if (accessIat < refreshIat || userID !== refreshUserID) throw new Error('logout');

	const originalPrint: string | undefined = req.body.print;

	// REDIS LOOKUP --------------------------------------------------------
	// Steps: require the session entry to exist; missing entry means logout/revocation already happened.
	const redisKey: string = `${userID}_${devID}`;
	const redisData: string | null = await redis.hget(REDIS_KEYS.refreshTokens, redisKey);
	if (!redisData) throw new Error('logout');

	// FINGERPRINT VALIDATION ----------------------------------------------
	// Steps: compare stored rJWT and (optionally) stored print; mismatch implies token theft or session hijack -> logout.
	const colonIndex: number = redisData.indexOf(':');
	const storedRJWT: string = colonIndex >= 0 ? redisData.slice(0, colonIndex) : redisData;
	const storedPrint: string = colonIndex >= 0 ? redisData.slice(colonIndex + 1) : '';

	// Token Mismatch -> Potential Theft -> Logout
	if (storedRJWT !== refreshToken) throw new Error('logout');

	const providedPrint: string | undefined = originalPrint;
	// Print Mismatch (except explicit renewal) -> Potential Session Hijacking -> Logout
	if (req.body.mode !== 'renewAccessToken' && providedPrint && storedPrint && storedPrint !== providedPrint) throw new Error('logout');
	const normalizedPrint: string = providedPrint || storedPrint;

	const deviceInfo: any = { logins: accessDecoded.logins, lastLogin: accessDecoded.lastLogin, devID };
	const expiredAt: number | null = (expiredError as any)?.expiredAt instanceof Date ? (expiredError as any).expiredAt.getTime() : null;

	try {
		// VERIFY rJWT SIGNATURE ----------------------------------------------
		// Steps: verify signature against dynamic secret for this hour slot; throws TokenExpiredError when rJWT is expired.
		const dynamicSecret: string = getDynamicSecret(userID, process.env.RJWT_SECRET as string, refreshIat);
		(JWT.verify as any)(refreshToken, dynamicSecret);

		// MINT aJWT -----------------------------------------------------------
		// Steps: mint a new access token; refresh token is not rotated in this path unless it is expired.
		await jwtCreate({ res, create: 'access', userID, is, deviceInfo, print: normalizedPrint, expiredAt });

		if (providedPrint === undefined) delete req.body.print;
		if (req.body.mode === 'renewAccessToken') {
			res.status(200).end();
			return null;
		}
		return { userID, is, devID, logins: accessDecoded.logins };
	} catch (verifyError: any) {
		// rJWT EXPIRED -> ROTATE BOTH ----------------------------------------
		// Steps: if rJWT is expired, rotate both tokens under SQL+redis persistence; for non-expiry failures, force logout.
		if (verifyError.name !== 'TokenExpiredError') {
			logger.error('aJWT expired', { req, userID, devID });
			throw new Error('logout');
		}
		let con: any;
		try {
			con = await Sql.getConnection();
			// Rotate BOTH tokens
			await jwtCreate({ res, con, create: 'both', userID, is, deviceInfo, print: normalizedPrint, expiredAt });
		} finally {
			if (con) con.release();
		}
		if (providedPrint === undefined) delete req.body.print;

		// SPECIAL CASE: Explicit Renewal Endpoint
		if (req.body.mode === 'renewAccessToken') {
			res.status(200).end();
			return null;
		}
		return { userID, is, devID, logins: 3 };
	}
}

/** ----------------------------------------------------------------------------
 * JWT VERIFY MIDDLEWARE
 * Primary Express middleware for protecting routes.
 * 1. Checks for Authorization header.
 * 2. Checks In-Memory LRU Cache (Fast Path).
 * 3. Verifies JWT Signature (Slow Path).
 * 4. Handles Expiration -> Triggers Refresh Flow.
 * Steps: accept token from header/body, bypass for explicitly public routes, use LRU cache fast-path, otherwise verify signature; on expiry run refresh flow and attach session.
 * -------------------------------------------------------------------------- */
async function jwtVerify(req: any, res: any, next: any): Promise<void> {
	let accessToken: string | undefined = req.headers.authorization?.split(' ')[1] || req.body.auth;

	if (!accessToken) {
		// PUBLIC ROUTES (Bypass Auth) -----------------------------------------
		// Entrance routes allow unauthenticated access for login/register/forgot flows
		// Event routes allow unauthenticated access for public event viewing
		if (req.url.startsWith('/entrance') || req.url.startsWith('/event')) {
			delete req.body.userID, delete req.body.devID;
			return next();
		}

		// BLOCK REQUEST -------------------------------------------------------
		return Catcher({ origin: 'jwtVerify', error: new Error('logout'), res });
	}

	// FAST PATH: LRU CACHE ----------------------------------------------------
	// If we've recently verified this token, skip crypto operations.
	const cachedDecoded: JWTPayload | undefined = jwtCache.get(accessToken);
	if (cachedDecoded) {
		const now: number = Math.floor(Date.now() / 1000);
		if (cachedDecoded.exp && cachedDecoded.exp > now) {
			attachSession(req, cachedDecoded);
			return next();
		} else {
			jwtCache.delete(accessToken);
		}
	}

	try {
		// SLOW PATH: CRYPTO VERIFY --------------------------------------------
		const decoded: JWTPayload = (JWT.verify as any)(accessToken, process.env.AJWT_SECRET as string) as JWTPayload;

		// UPDATE CACHE
		const now: number = Math.floor(Date.now() / 1000);
		const ttl: number = decoded.exp ? Math.min((decoded.exp - now) * 1000, 3600000) : 3600000;
		jwtCache.set(accessToken, decoded, { ttl });

		attachSession(req, decoded);
		return next();
	} catch (error: any) {
		// TOKEN EXPIRED OR INVALID --------------------------------------------
		if (error.name !== 'TokenExpired' && error.name !== 'TokenExpiredError') {
			logger.error('jwtVerify failure', { error, req, path: req.originalUrl, userID: req.body?.userID });
			return Catcher({ origin: 'jwtVerify', error: Object.assign(error, { message: 'unauthorized' }), res });
		}

		try {
			// REISSUE ACCESS TOKEN ------------------------------------------------
			const refreshed: any = await refreshAccessToken(req, res, accessToken!, error);
			if (refreshed === null) return; // Response handled inside refresh
			attachSession(req, refreshed);
			return next();
		} catch (refreshError: any) {
			logger.error('jwtVerifyRefresh failure', { error: refreshError, req, path: req.originalUrl, userID: req.body?.userID });
			if (refreshError?.message === 'logout') return Catcher({ origin: 'jwtVerify', error: Object.assign(refreshError, { message: 'unauthorized' }), res });
			return Catcher({ origin: 'jwtVerify', error: Object.assign(refreshError, { message: 'tokenExpired' }), res });
		}
	}
}

// HELPER: ATTACH SESSION DATA -------------------------------------------------
// Injects authenticated user data into the request body for downstream controllers.
// Steps: attach user identity + device identity + stability hint so downstream modules can conditionally skip SQL overlays.
function attachSession(req: any, { userID, is, devID, logins }: JWTPayload): void {
	Object.assign(req.body, { userID, devID, is, devIsStable: is === 'newUser' || !logins });
}

interface JwtQuickiesProps {
	mode: 'verify' | 'create';
	payload: any;
	expiresIn?: string | number | null;
}

/** ----------------------------------------------------------------------------
 * JWT QUICKIES
 * Helper for generating/verifying temporary, single-purpose tokens.
 * Used for email verification links, password resets, etc.
 * Steps: verify returns decoded payload, create signs payload with short expiry; throws normalized 'tokenExpired'/'unauthorized' codes.
 * -------------------------------------------------------------------------- */
function jwtQuickies({ mode, payload, expiresIn = null }: JwtQuickiesProps): any {
	try {
		if (mode === 'verify') return (JWT.verify as any)(payload, process.env.AJWT_SECRET as string);
		else if (mode === 'create') return (JWT.sign as any)(payload, process.env.AJWT_SECRET as string, { expiresIn: expiresIn || EXPIRATIONS.authToken });
	} catch (error: any) {
		throw new Error(`${error.name === 'TokenExpiredError' ? 'tokenExpired' : 'unauthorized'}`);
	}
}

export { jwtVerify, jwtCreate, jwtQuickies, ioRedisSetter, invalidateCacheForDevice };
