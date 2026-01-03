import { decode } from 'cbor-x';
import fsp from 'fs/promises';
import path from 'path';
import { getLogger } from './loggers';

const logger = getLogger('Streamer');

// STREAMER --------------------------------------------------------------------

// Cache of created consumer groups with TTL to avoid repeated "group already exists" warnings
// Use Map with timestamps to allow periodic refresh and prevent unbounded growth
// Steps: keep a bounded local memo so we don’t hammer XGROUP CREATE on every poll loop; BUSYGROUP still treated as success.
const createdGroups = new Map();
const CREATED_GROUPS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CREATED_GROUPS_MAX_SIZE = 1000;

// MAIN HANDLER ---------------------------------------------------------------
// Consumes messages from Redis streams via consumer groups.
// Supports:
// - ensureGroup: idempotent group creation with local TTL cache
// - xautoclaim: recovery for stuck pending messages
// - CBOR decode of `payload` field
// Return contains items + ids + ack() helper to XACK processed IDs.
// Steps: ensure group exists, optionally claim idle pending items, read fresh items, decode payloads, merge claimed+fresh, return {items, ids, ack}.
export async function Streamer({ streamName, redis, logPrefix = '[stream]', count, blockMs, group, consumer, claimIdleMs, claimCount }) {
	// Validate Redis client
	if (!redis || typeof redis.xread !== 'function') {
		throw new Error('Invalid redis client');
	}

	try {
		// Consumer group mode only
		if (group && consumer) {
			await ensureGroup({ redis, streamName, group, logPrefix });

			// Optionally claim idle pending entries first (recovery of stuck work)
			let claimedItems = [];
			let claimedIds = [];
			if (claimIdleMs && Number(claimIdleMs) > 0) {
				try {
					const argsClaim = [streamName, group, consumer, Number(claimIdleMs), '0-0'];
					if (claimCount && Number(claimCount) > 0) argsClaim.push('COUNT', Number(claimCount));
					const claimRes = await xautoclaimMaybeBuffer(redis, argsClaim);
					// claimRes is [nextId, [[id, fields], ...]]
					const claimedEntries = Array.isArray(claimRes) && Array.isArray(claimRes[1]) ? claimRes[1] : [];
					if (claimedEntries.length) {
						const dec = decodeGroupItems(claimedEntries);
						claimedItems = dec.items;
						claimedIds = dec.ids;
						if (dec.errors.length) {
							await saveErrors(streamName, 'decode', dec.errors);
							logger.alert('streamer.decode_errors', {
								streamName,
								count: dec.errors.length,
								source: 'claimed',
								logPrefix,
							});
						}
					}
				} catch (e) {
					logger.error('streamer.xautoclaim_failed', { error: e, streamName, logPrefix });
				}
			}

			const args = ['GROUP', group, consumer];
			if (count && Number(count) > 0) args.push('COUNT', Number(count));
			if (blockMs && Number(blockMs) > 0) args.push('BLOCK', Number(blockMs));
			args.push('STREAMS', streamName, '>');
			const result = await xreadgroupMaybeBuffer(redis, args);

			const freshEntries = result?.length ? result[0][1] : [];
			const hasFresh = freshEntries && freshEntries.length > 0;
			if (!hasFresh && claimedItems.length === 0) {
				return { processed: 0, success: true, items: [], ids: [], ack: async () => 0 };
			}

			const entries = hasFresh ? freshEntries : [];
			const { items, ids, errors: decodeErrors } = hasFresh ? decodeGroupItems(entries) : { items: [], ids: [], errors: [] };
			if (decodeErrors.length) {
				await saveErrors(streamName, 'decode', decodeErrors);
				logger.alert('streamer.decode_errors', { streamName, count: decodeErrors.length, source: 'fresh', logPrefix });
			}

			// Merge claimed + fresh
			const allItems = claimedItems.length ? claimedItems.concat(items) : items;
			const allIds = claimedIds.length ? claimedIds.concat(ids) : ids;
			return {
				items: allItems,
				ids: allIds,
				processed: allItems.length,
				success: true,
				ack: async (toAckIds = allIds) => {
					if (!toAckIds?.length) return 0;
					try {
						return await redis.xack(streamName, group, ...toAckIds);
					} catch (error) {
						logger.error('streamer.ack_failed', { error, streamName, logPrefix });
						return 0;
					}
				},
			};
		}
	} catch (error) {
		logger.error('streamer.fetch_failed', { error, streamName, logPrefix });
		throw error;
	}
}

// HELPERS --------------------------------------------------------------------

// DECODE GROUP ITEMS ----------------------------------------------------------
// Converts XREADGROUP entries into plain JS objects by CBOR-decoding the `payload` field.
// Returns { items, ids, errors } where errors are persisted for inspection.
// Steps: read stream ID, locate `payload` field, CBOR-decode into object, attach _streamId, and collect decode failures for later inspection.
function decodeGroupItems(entries) {
	const items = [];
	const ids = [];
	const errors = [];

	for (const entry of entries) {
		const id = entry[0].toString('utf-8');
		try {
			const payload = findPayload(entry[1]);
			const item = decode(payload);
			item._streamId = id;
			items.push(item);
			ids.push(id);
		} catch (e) {
			errors.push({ id, error: e.message });
		}
	}

	return { items, ids, errors };
}

// SAVE ERRORS -----------------------------------------------------------------
// Persists decode or processing errors to disk to make failures inspectable post-mortem.
// This is best-effort and should never throw back into stream consumption.
// Steps: chunk errors to bounded JSON files, write into logs/failed_items, and never fail the stream consumer on IO issues.
async function saveErrors(streamName, errorType, items) {
	if (!items || items.length === 0) return;

	try {
		const dir = path.join(process.cwd(), 'logs', 'failed_items');
		await fsp.mkdir(dir, { recursive: true });

		// Cap file size and rotate
		const maxPerFile = Number(process.env.STREAMER_MAX_ERRORS_PER_FILE) || 500;
		const chunks = [];
		for (let i = 0; i < items.length; i += maxPerFile) chunks.push(items.slice(i, i + maxPerFile));
		for (const [idx, chunk] of chunks.entries()) {
			const filename = path.join(dir, `${streamName}_${errorType}_${Date.now()}_${idx}.json`);
			await fsp.writeFile(filename, JSON.stringify(chunk, null, 2));
		}

		logger.alert('streamer.errors_saved', {
			streamName,
			errorType,
			itemCount: items.length,
			filesCreated: chunks.length,
		});
	} catch (error) {
		logger.error('streamer.save_errors_failed', { error, streamName, errorType });
	}
}

// PAYLOAD FIELD CHECK ---------------------------------------------------------
// Stream payloads are stored under field name `payload`; field may be Buffer or string.
// Steps: normalize field name to utf-8 string and compare against the canonical payload key.
function isPayloadFieldName(field) {
	if (!field) return false;
	if (Buffer.isBuffer(field)) return field.toString('utf-8') === 'payload';
	return String(field) === 'payload';
}

// PAYLOAD EXTRACTION ----------------------------------------------------------
// Extracts the `payload` entry from a redis stream field list: [k1,v1,k2,v2,...].
// Throws if not found because caller cannot decode without it.
// Steps: walk alternating key/value list, stop on key==="payload", return the value, otherwise fail fast so caller can persist a decode error.
function findPayload(fields) {
	// fields is an array like [key1, val1, key2, val2, ...]
	for (let i = 0; i < fields.length - 1; i += 2) {
		if (isPayloadFieldName(fields[i])) {
			return fields[i + 1];
		}
	}
	throw new Error('Payload field not found');
}

// ENSURE GROUP ----------------------------------------------------------------
// Idempotently creates a consumer group with MKSTREAM, caching successes locally to avoid BUSYGROUP spam.
// Steps: use a TTL cache to avoid repeated CREATE attempts, create with MKSTREAM, swallow BUSYGROUP as success, and keep cache bounded.
async function ensureGroup({ redis, streamName, group, logPrefix }) {
	// Check cache first to avoid redundant group creation attempts
	const groupKey = `${streamName}:${group}`;
	const cachedTs = createdGroups.get(groupKey);
	const now = Date.now();

	// Cache hit and not expired
	if (cachedTs && now - cachedTs < CREATED_GROUPS_TTL_MS) {
		return;
	}

	// Cleanup old entries if cache is too large
	if (createdGroups.size > CREATED_GROUPS_MAX_SIZE) {
		const cutoff = now - CREATED_GROUPS_TTL_MS;
		for (const [key, ts] of createdGroups) {
			if (ts < cutoff) createdGroups.delete(key);
		}
	}

	try {
		const startId = process.env.STREAM_GROUP_START_ID || '$';
		await redis.xgroup('CREATE', streamName, group, startId, 'MKSTREAM');
		createdGroups.set(groupKey, now);
		// NOTE: Removed group_created log - too noisy during startup with multiple worker threads
	} catch (e) {
		const msg = String(e?.message || e);
		if (!msg.includes('BUSYGROUP') && !msg.includes('Consumer Group name already exists')) {
			logger.error('streamer.ensure_group_failed', { error: e, streamName, group, logPrefix });
			throw e;
		}
		// If it is BUSYGROUP, we swallow the error because it just means the group exists, which is what we want.
		// Add to cache so we don't try again
		createdGroups.set(groupKey, now);
	}
}

// BUFFER-AWARE REDIS COMMANDS -------------------------------------------------
// Uses *Buffer variants when available so CBOR payloads can be decoded without re-encoding overhead.
// Steps: prefer Buffer-returning commands to avoid accidental utf-8 coercion of binary payloads.
async function xreadgroupMaybeBuffer(redis, args) {
	if (typeof redis.xreadgroupBuffer === 'function') return await redis.xreadgroupBuffer(...args);
	return await redis.xreadgroup(...args);
}

async function xreadMaybeBuffer(redis, args) {
	if (typeof redis.xreadBuffer === 'function') return await redis.xreadBuffer(...args);
	return await redis.xread(...args);
}

async function xautoclaimMaybeBuffer(redis, args) {
	if (typeof redis.xautoclaimBuffer === 'function') return await redis.xautoclaimBuffer(...args);
	return await redis.xautoclaim(...args);
}
