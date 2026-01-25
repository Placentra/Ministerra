import { encode, decode } from 'cbor-x';
import { Sql } from '../../systems/systems.ts';
import { broadcastMessSeen } from '../../systems/socket/chatHandlers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { LRUCache } from 'lru-cache';

const logger = getLogger('SeenSync');

const [STREAM_MAXLEN, CACHE_LIMIT] = [Number(process.env.STREAM_MAXLEN) || 50000, Number(process.env.CHAT_SEEN_CACHE_LIMIT) || 10000];

// SEEN SYNC MODULE -------------------------------------------------------------
// Provides a bounded, incremental sync protocol for chat "seen" pointers:
// - writeSeenEntriesToCache writes versioned seen updates into redis (hash + zset)
// - fetchSeenUpdates returns delta updates since last client version, with SQL fallback
// - messSeen emits to stream for DB persistence and broadcasts to connected users

// MICRO-CACHE -----------------------------------------------------------------
// Steps: cache computed delta results for (chatID,prevSync) briefly so bursty polling doesn’t repeatedly hit redis+decode; writes invalidate per-chat entries explicitly.
const seenUpdateCache = new LRUCache({
	max: 1000, // Active chats
	ttl: 10000, // 10 seconds
	updateAgeOnGet: false,
});

// LUA SCRIPT: TRIM SEEN CACHE -------------------------------------------------
// Trims the seen cache (ZSET + HASH) to a fixed size to prevent memory bloat.
// Uses Lua for atomicity.
// KEYS[1]: Hash key (chatSeen:{id})
// KEYS[2]: ZSet key (chatSeenChanged:{id})
// ARGV[1]: Cache limit (number)
// LUA TRIM WITH BATCHED HDEL ---
// Steps: use loop instead of unpack to avoid Lua stack overflow on large result sets (unpack has ~8000 element limit).
const LUA_TRIM = `local h=KEYS[1];local z=KEYS[2];local l=tonumber(ARGV[1]);if not l or l<=0 then return 0 end;local s=redis.call('ZCARD',z);local o=s-l;if o<=0 then return 0 end;local r=redis.call('ZRANGE',z,0,o-1);for i=1,#r do redis.call('HDEL',h,r[i]) end;redis.call('ZREMRANGEBYRANK',z,0,o-1);return o`;

// LUA SCRIPT: PREPARE WRITE ---------------------------------------------------
// Atomically checks monotonicity, allocates versions, and updates max trackers.
// KEYS[1]: chatSeenMax:{id}
// KEYS[2]: chatSeenVersion (Hash)
// KEYS[3]: lastSeenChangeAt (Hash)
// ARGV[1]: chatID
// ARGV[2+]: Pairs of (key, seenId)
const LUA_PREPARE = `
local maxH = KEYS[1]
local verH = KEYS[2]
local lastH = KEYS[3]
local chatID = ARGV[1]
local inputKeys = {}
local inputVals = {}
local n = 0
for i=2, #ARGV, 2 do
    n = n + 1
    inputKeys[n] = ARGV[i]
    inputVals[n] = tonumber(ARGV[i+1])
end
if n == 0 then return {} end
local currents = redis.call('HMGET', maxH, unpack(inputKeys))
local result = {}
local maxUpdates = {}
local lastVer = redis.call('HINCRBY', verH, chatID, n)
local startVer = lastVer - n + 1
for i=1, n do
    local cur = tonumber(currents[i])
    local final = inputVals[i]
    if cur and final and cur > final then final = cur end
    if final then
        table.insert(maxUpdates, inputKeys[i])
        table.insert(maxUpdates, final)
    end
    table.insert(result, inputKeys[i])
    table.insert(result, final or 0) -- Use 0 for null/undefined if necessary, or handle in JS
    table.insert(result, startVer + i - 1)
end
if #maxUpdates > 0 then redis.call('HSET', maxH, unpack(maxUpdates)) end
redis.call('HSET', lastH, chatID, lastVer)
return result
`;

let redis;
// SET REDIS CLIENT ------------------------------------------------------------
// Steps: accept the shared redis client, then define the Lua command once so trimming stays atomic and cheap.
export const setSeenRedisClient = (c: any): void => {
	redis = c;
	c?.defineCommand('chatSeenTrim', { numberOfKeys: 2, lua: LUA_TRIM });
	c?.defineCommand('chatSeenPrepare', { numberOfKeys: 3, lua: LUA_PREPARE });
};

// KEYS ------------------------------------------------------------------------
// Steps: keep key formatting centralized so hash/zset pairs never drift.
const keys = (id: string | number): { hash: string; zset: string; maxHash: string } => ({ hash: `chatSeen:${id}`, zset: `chatSeenChanged:${id}`, maxHash: `chatSeenMax:${id}` });

// HELPERS ---------------------------------------------------------------------

// SAFE NUMBER PARSER ----------------------------------------------------------
// Steps: coerce to Number, reject NaN/Infinity, return null for “not set” values.
const toNum = (v: any): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// BUFFER CONVERTER ------------------------------------------------------------
// Steps: normalize redis payload inputs into Buffer so CBOR decode/encode paths stay consistent.
const toBuf = (v: any): Buffer => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(v));

interface CacheEntry {
	id: number;
	seenId: number | null;
	ts: number;
}

// CACHE PARSER ----------------------------------------------------------------
// Steps: decode CBOR, normalize types, and default timestamps so later sort/merge logic is stable; return null on corruption.
const parseCache = (mid: string | number, val: Buffer): CacheEntry | null => {
	try {
		const dec: any = decode(val);
		return { id: Number(mid), seenId: toNum(dec.seenId), ts: toNum(dec.ts) || Date.now() };
	} catch {
		return null;
	}
};

// MAP UPSERT ------------------------------------------------------------------
// Steps: keep only the newest version per memberId so duplicate/overlapping sources collapse deterministically.
const upsert = (map: Map<number, CacheEntry>, { id, seenId, ts }: CacheEntry): void => {
	const exist: CacheEntry | undefined = map.get(id);
	if (!exist || (exist.ts || 0) < ts) map.set(id, { id, seenId, ts: ts || 0 });
};

interface WriteSeenResult {
	lastVersion: number;
	entries: { memberId: number; seenId: number | null; version: number }[];
}

// WRITE CACHE -----------------------------------------------------------------
// Steps: normalize input entries, allocate monotonic versions, write payloads into HASH and membership into ZSET,
// then bump lastSeenChangeAt so clients can cheap-check “anything changed?”, then trim asynchronously.
export async function writeSeenEntriesToCache(chatID: string | number, entries: any[] = [], updatedAt: number = Date.now()): Promise<WriteSeenResult | null> {
	if (!redis || !entries.length) return null;
	const norm: { mid: number; key: string; seen: number | null }[] = entries
		.map(e => e?.id && { mid: Number(e.id), key: String(e.id), seen: toNum(e.seenId) })
		.filter((e): e is { mid: number; key: string; seen: number | null } => !!e);
	if (!norm.length) return null;

	// MONOTONIC SEEN NORMALIZATION & VERSION ALLOCATION (ATOMIC LUA) -----------
	// Steps: use Lua to atomically check max-seen, allocate versions, and update metadata.
	// This eliminates the race condition between reading 'max' and writing 'current'.
	const { hash, zset, maxHash }: { hash: string; zset: string; maxHash: string } = keys(chatID);
	const luaArgs = [chatID, ...norm.flatMap(e => [e.key, String(e.seen || 0)])];
	
	// Returns flat array: [key, finalSeen, version, key, finalSeen, version, ...]
	const prepared: (string | number)[] = await (redis as any).chatSeenPrepare(maxHash, 'chatSeenVersion', REDIS_KEYS.lastSeenChangeAt, ...luaArgs);
	
	if (!prepared || !prepared.length) return null;

	const pipe: any = redis.multi();
	const [hArgs, zArgs, res]: [any[], any[], any[]] = [[], [], []];
	let lastVer = 0;

	// COMMAND STAGING ---
	// Steps: stage HSET and ZADD based on the atomic decisions made by Lua.
	for (let i = 0; i < prepared.length; i += 3) {
		const key = String(prepared[i]);
		const seen = Number(prepared[i + 1]) || null;
		const ver = Number(prepared[i + 2]);
		
		// Map back to memberId (key is String(id))
		const mid = Number(key);
		
		hArgs.push(key, toBuf(encode({ seenId: seen, ts: ver, updatedAt })));
		zArgs.push(ver, key);
		res.push({ memberId: mid, seenId: seen, version: ver });
		if (ver > lastVer) lastVer = ver;
	}

	// ATOMIC-ish WRITE ---
	// Steps: write the payloads. Metadata (max, version, lastChange) was already updated by Lua.
	if (hArgs.length) pipe.hset(hash, ...hArgs);
	if (zArgs.length) pipe.zadd(zset, ...zArgs);

	await pipe.exec();
	
	// ASYNC TRIM ---
	// Steps: trim in background so writes stay low-latency; fallback to raw eval if the custom command is missing.
	(redis as any).chatSeenTrim(hash, zset, CACHE_LIMIT).catch((err: any) => {
		logger.error('writeSeenEntriesToCache.trim_failed_lua', { error: err });
		redis.eval(LUA_TRIM, 2, hash, zset, CACHE_LIMIT).catch((e: any) => logger.error('writeSeenEntriesToCache.trim_failed_eval', { error: e }));
	});

	// INVALIDATE LOCAL CACHE
	// Steps: force subsequent reads to recompute from redis/DB so we never serve a stale delta after a write.
	seenUpdateCache.delete(String(chatID));

	return { lastVersion: lastVer, entries: res };
}

interface FetchSeenUpdatesProps {
	chatID: string | number;
	chatType: string;
	seenSync: string | number;
	lastChange?: string | number;
	con?: any;
}

interface FetchSeenUpdatesResult {
	seenUpdates: { id: number; seenId: number | null }[] | null;
	seenSync: number;
}

// FETCH UPDATES ---------------------------------------------------------------
// Steps: if client already has the latest version, return null updates; otherwise use zrangebyscore(since+1)
// as the delta index, then hmget the payloads, then fill any holes by reading SQL and re-writing cache.
export async function fetchSeenUpdates({ chatID, chatType, seenSync: prev, lastChange, con }: FetchSeenUpdatesProps): Promise<FetchSeenUpdatesResult> {
	if (chatType === 'private' || !redis) return { seenUpdates: null, seenSync: Number(lastChange || prev || 0) };

	// CACHE HIT?
	// If we have a fresh result for this exact sync point, return it.
	// We key by chatID + prevSync to ensure we return correct incremental deltas.
	const cacheKey: string = `${chatID}:${prev || 0}`;
	const cached: FetchSeenUpdatesResult | undefined = seenUpdateCache.get(cacheKey) as FetchSeenUpdatesResult | undefined;
	if (cached) return cached;

	let localCon: any;
	try {
		const [since, last]: [number, number] = [Number(prev) || 0, Number(lastChange || (await redis.hget(REDIS_KEYS.lastSeenChangeAt, String(chatID))) || 0)];
		if (since && last && since >= last) {
			// NO-OP DELTA ---
			// Steps: client is already caught up; cache this exact response to collapse bursts.
			const res: FetchSeenUpdatesResult = { seenUpdates: null, seenSync: last };
			seenUpdateCache.set(cacheKey, res);
			return res;
		}

		const { hash, zset }: { hash: string; zset: string } = keys(chatID);
		const updates: Map<number, CacheEntry> = new Map<number, CacheEntry>();
		let maxVer: number = last;

		// Fetch incremental updates
		if (since) {
			// DELTA PATH ---
			// Steps: list changed member IDs by version score, then fetch payloads for just those members.
			const changed: (string | number)[] = await redis.zrangebyscore(zset, since + 1, '+inf');
			if (!changed.length) return { seenUpdates: null, seenSync: last || since };

			const vals: (Buffer | null)[] = await redis.hmgetBuffer(hash, ...changed.map(String));
			const missing: number[] = [];

			changed.forEach((id, i) => {
				const p: CacheEntry | null = vals[i] ? parseCache(id, vals[i]!) : null;
				p ? upsert(updates, p) : missing.push(Number(id));
			});

			// Handle cache misses by fetching from DB
			if (missing.length) {
				// HOLE FILL ---
				// Steps: read missing rows from SQL, then immediately push them back into redis so future deltas stop hitting SQL.
				if (!con) (localCon = await Sql.getConnection()), (con = localCon);
				const [rows]: [any[], any] = await con.execute(`SELECT id, seen FROM chat_members WHERE chat = ? AND id IN (${missing.map(() => '?').join(',')})`, [chatID, ...missing]);
				if (rows.length) {
					const res: WriteSeenResult | null = await writeSeenEntriesToCache(
						chatID,
						rows.map(r => ({ id: Number(r.id), seenId: toNum(r.seen) })),
						Date.now()
					);
					res?.entries.forEach(e => upsert(updates, { id: Number(e.memberId), seenId: e.seenId, ts: Number(e.version) || last }));
					if (res?.lastVersion) maxVer = Math.max(maxVer, res.lastVersion);
				}
			}
		} else {
			// FULL STATE PATH ---
			// Steps: when client has no sync marker, reconstruct from cache if possible; otherwise fall back to SQL and repopulate cache.
			let mems: (string | number)[] = await redis.zrange(zset, 0, -1);
			if (!mems?.length && (await redis.hlen(hash)) > 0) mems = await redis.hkeys(hash);

			if (mems?.length) {
				const vals: (Buffer | null)[] = await redis.hmgetBuffer(hash, ...mems.map(String));
				mems.forEach((id, i) => {
					if (vals[i]) {
						const p: CacheEntry | null = parseCache(id, vals[i]!);
						if (p) upsert(updates, p);
					}
				});
			}

			// Fallback to DB if cache is empty
			if (!updates.size) {
				// CACHE EMPTY RECOVERY ---
				// Steps: query authoritative table, then immediately writeSeenEntriesToCache so next call is pure-redis.
				if (!con) (localCon = await Sql.getConnection()), (con = localCon);
				const [rows]: [any[], any] = await con.execute(`SELECT id, seen FROM chat_members WHERE chat = ?`, [chatID]);
				if (!rows.length) return { seenUpdates: null, seenSync: last || since };

				const res: WriteSeenResult | null = await writeSeenEntriesToCache(
					chatID,
					rows.map(r => ({ id: Number(r.id), seenId: toNum(r.seen) })),
					Date.now()
				);
				res?.entries.forEach(e => upsert(updates, { id: Number(e.memberId), seenId: e.seenId, ts: Number(e.version) || last }));
				if (res?.lastVersion) maxVer = Math.max(maxVer, res.lastVersion);
			}
		}

		if (!updates.size) return { seenUpdates: null, seenSync: maxVer || since };

		// ORDER + SHAPE OUTPUT ---
		// Steps: sort by version so the client can apply changes in order, then emit only the minimal fields needed by the protocol.
		const ordered: CacheEntry[] = Array.from(updates.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
		const result: FetchSeenUpdatesResult = {
			seenUpdates: ordered.map(({ id, seenId }) => ({ id, seenId })),
			seenSync: ordered.reduce((max, i) => Math.max(max, Number(i.ts) || 0), maxVer || 0),
		};

		seenUpdateCache.set(cacheKey, result);
		return result;
	} finally {
		localCon?.release();
	}
}

interface MessSeenProps {
	chatID: string | number;
	messID: string | number;
	role: string;
	userID: string | number;
	socket?: any;
}

// MESSAGE SEEN ----------------------------------------------------------------
// Updates seen status for a user, broadcasting to others and updating cache.
// Persists update to Redis Stream for DB sync worker.
export async function messSeen({ chatID, messID, role, userID, socket }: MessSeenProps): Promise<void> {
	// SEEN UPDATE GATE ---------------------------------------------------------
	// Private chats do not use this sync path; privileged roles may be excluded to avoid leaking presence semantics.
	if (role !== 'priv') {
		// PERSIST BEFORE BROADCAST ---
		// Steps: write to stream and cache first so broadcast only happens after persistence succeeds; prevents "seen" checkmarks that vanish on refresh.
		await redis.xadd('lastSeenMess', 'MAXLEN', '~', STREAM_MAXLEN, '*', 'payload', encode([chatID, userID, messID]));
		await writeSeenEntriesToCache(chatID, [{ id: userID, seenId: Number(messID) }]);
		broadcastMessSeen({ socket, chatID, userID, messID });
	}
}
