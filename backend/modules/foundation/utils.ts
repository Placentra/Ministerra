// FOUNDATION UTILITIES ----------------------------------------------------------
// Shared helpers for Foundation "load" endpoint:
// - sync watermark resolution/persistence per device
// - consistent redis key generation for user summary state

// UTILITIES ----------------------------------------------------------------------
import { getLogger } from '../../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('FoundationUtils');
let redis: any;

// REDIS CLIENT SETTER ----------------------------------------------------------
// Steps: inject redis once at startup so helpers can be pure(ish) and we avoid import cycles.
const setRedis = (client: any): any => (redis = client);

// USER SUMMARY KEY -------------------------------------------------------------
// Steps: centralize key shape so callers can’t drift; summary hashes act as the “change watermark” store for sync logic.
const userSummaryKey = (userID: string | number): string => `${REDIS_KEYS.userSummary}:${userID}`;

// RESOLVE DEVICE SYNC ----------------------------------------------------------
// Steps: clamp client timestamp to sane bounds, then merge with stored per-device watermark so we never rewind and miss updates (clock skew / replay guard).
async function resolveDeviceSync(userID: string | number, devID: string, clientDevSync: string | number): Promise<number> {
	const numericClient: number = Number(clientDevSync) || 0;
	const now: number = Date.now();
	// CLIENT CLAMP ------------------------------------------------------------
	// Steps: cap future timestamps so a bad clock can’t “future-lock” the device forever.
	const safeClient: number = numericClient > now + 60000 ? now : numericClient;

	if (!devID || !redis) return safeClient;

	try {
		// MERGE WITH STORED WATERMARK ---------------------------------------
		// Steps: use max(client,stored) so we only ever move forward and fetch minimal deltas.
		const stored: string | null = await redis.hget(userSummaryKey(userID), `devSync:${devID}`);
		return Math.max(safeClient, Number(stored) || 0);
	} catch (error) {
		logger.error('resolveDeviceSync', { error, userID, devID, clientDevSync });
		return safeClient;
	}
}

// PERSIST DEVICE SYNC ----------------------------------------------------------
// Steps: after successful sync, persist the newest watermark so subsequent requests can be delta-based; do nothing when devID/redis missing.
async function persistDeviceSync(userID: string | number, devID: string, devSync: string | number, linksSync: string | number): Promise<void> {
	if (!devID || !redis) return;
	// WATERMARK PICK ----------------------------------------------------------
	// Steps: store the max watermark so we don’t regress when linksSync/devSync are advanced on different paths.
	const latest: number = Math.max(Number(devSync) || 0, Number(linksSync) || 0);
	if (!latest) return;

	try {
		await redis.hset(userSummaryKey(userID), `devSync:${devID}`, latest);
	} catch (error) {
		logger.error('persistDeviceSync', { error, userID, devID, devSync, linksSync });
	}
}

export { setRedis, resolveDeviceSync, persistDeviceSync, userSummaryKey, redis };
