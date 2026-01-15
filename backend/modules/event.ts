import { Sql, Catcher } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { createEveMeta } from '../utilities/helpers/metasCreate.ts';
import { getGeohash } from '../utilities/helpers/location.ts';
import { checkRedisAccess } from '../utilities/contentFilters.ts';
import { encode, decode } from 'cbor-x';
import { calculateAge, delFalsy } from '../../shared/utilities.ts';
import { LRUCache } from 'lru-cache';
import { Redis, Pipeline } from 'ioredis';

// META INDEXES ------------------------------------------
import { EVENT_META_INDEXES, REDIS_KEYS, EVENT_COLUMNS, EVENT_BASICS_KEYS, EVENT_DETAILS_KEYS } from '../../shared/constants.ts';
const { evePrivIdx, eveOwnerIdx, eveStartsIdx, eveTypeIdx, eveBasiVersIdx, eveDetailsVersIdx } = EVENT_META_INDEXES;

interface EventRequest {
	eventID: number | string;
	userID?: number | string;
	gotUsers?: boolean;
	devIsStable?: boolean;
	state?: 'noMeta' | string;
	basiVers?: string | number;
	detaVers?: string | number;
	getBasiOnly?: boolean;
	gotSQL?: boolean;
	lastUsersSync?: number;
}

interface EventMetaInput {
	priv: string;
	owner: number | string;
	cityID: number | string;
	type: string;
	starts: string;
	geohash: string | null;
	surely: number;
	maybe: number;
	comments: number;
	score: number;
	basiVers: string | number;
	detaVers: string | number;
}

interface FetchProps {
	eventID: number | string;
	getBasi: boolean;
	getDeta: boolean;
	devIsStable?: boolean;
	userID?: number | string;
	gotUsers?: boolean;
	lastUsersSync?: number;
	gotSQL?: boolean;
	isOwn: boolean;
	con: any;
	isFriendly: boolean;
}

let redis: Redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Event handler uses redis for metas/basi/deta caches and past-event cache buckets.
export const ioRedisSetter = (redisClient: Redis) => (redis = redisClient);
const logger = getLogger('Event');
let geohash: any;

// LOCAL CACHE -----------------------------------------------------------------
// Steps: cache the heaviest event components in-process so repeated reads avoid redis round-trips; invalidation is explicit so stale data can be dropped after writes.
const eventCache = new LRUCache<string, any>({
	max: 1000, // Top 1000 active events
	ttl: 5 * 60 * 1000, // 5 minutes matching task cycle
	updateAgeOnGet: false,
});

// SQL QUERIES -----------------------------------------------------------------
const QUERIES = {
	rating: `SELECT ei.inter, ei.priv AS interPriv, er.mark, er.awards FROM eve_inters ei LEFT JOIN eve_rating er ON ei.event = er.event AND er.user = ? WHERE ei.event = ? AND ei.user = ?`,
	pastUsers: `SELECT u.id, ei.priv, u.score, u.imgVers, u.first, u.last, u.birth FROM users u JOIN eve_inters ei ON u.id = ei.user WHERE ei.event = ? AND ei.inter IN ('sur', 'may') ORDER BY CASE ei.inter WHEN 'sur' THEN 1 WHEN 'may' THEN 2 END, u.score DESC`,
};

// IS EVENT PAST ----------------------------------------------------------------
// Steps: read starts from compact meta (base36) and compare with now; avoids parsing full objects for a cheap “past vs future” branch.
// Rationale: events are considered past only after a 2-hour grace period to ensure ongoing events remain visible in future views.
const isEventPast = (meta: any[]) => parseInt(meta[eveStartsIdx], 36) < Date.now() - 7200000;
// GET EVENT RATING -------------------------------------------------------------
// Steps: read user-specific overlay (inter/priv/mark/awards) from SQL; when userID is missing, return empty overlay.
const getEventRating = async (connection: any, userID: number | string | undefined, eventID: number | string) =>
	userID ? (await connection.execute(QUERIES.rating, [userID, eventID, userID]))[0][0] || {} : {};

// HANDLERS --------------------------------------------------------------------

// CACHE PAST EVENT ------------------------------------------------------------
// Steps: read event row from SQL, build meta + basi + deta payloads, write them into redis, and clear future caches so past representation becomes the source of truth.
async function cachePastEvent(eventID: number | string, connection: any) {
	const [[eventData]]: [any[], any] = await connection.execute(`SELECT ${EVENT_COLUMNS} FROM events e INNER JOIN cities c ON e.cityID = c.id WHERE e.id = ?`, [eventID]);
	if (!eventData) throw new Error('notFound');

	geohash ??= getGeohash();
	const startsBase36 = new Date(eventData.starts).getTime().toString(36);
	const geohashValue = eventData.lat && eventData.lng && geohash?.encode ? geohash.encode(eventData.lat, eventData.lng, 9) : null;
	const metaInput: EventMetaInput = {
		priv: eventData.priv,
		owner: eventData.owner,
		cityID: eventData.cityID,
		type: eventData.type,
		starts: startsBase36,
		geohash: geohashValue,
		surely: eventData.surely,
		maybe: eventData.maybe,
		comments: eventData.comments,
		score: eventData.score,
		basiVers: eventData.basiVers,
		detaVers: eventData.detaVers,
	};
	const [meta, basicsData, detailsData, pipeline]: [any[], Record<string, any>, Record<string, any>, Pipeline] = [createEveMeta(metaInput), {}, {}, redis.pipeline()];
	EVENT_BASICS_KEYS.forEach(col => (basicsData[col] = col === 'ends' && eventData[col] ? Number(new Date(eventData[col])) : col === 'starts' ? Number(new Date(eventData[col])) : eventData[col]));
	EVENT_DETAILS_KEYS.forEach(col => (detailsData[col] = col === 'meetWhen' && eventData[col] ? Number(new Date(eventData[col])) : eventData[col]));

	// CACHE UPDATE -----------------------------------------------------------
	// Steps: store encoded meta/basi/deta in one hash, track cachedAt in zset, then delete future hashes so clients don’t mix “future” and “past” shapes.
	pipeline
		.hset(`pastEve:${eventID}`, 'meta', encode(meta), 'basi', encode(basicsData), 'deta', encode(detailsData))
		.zadd(`pastEveCachedAt`, Date.now() + 604800000, eventID as any)
		.del(`${REDIS_KEYS.eveBasics}:${eventID}`, `${REDIS_KEYS.eveDetails}:${eventID}`);

	// USER LIST CACHING ------------------------------------------------------
	// Steps: for friend-type events, cache an attendee snapshot so past event pages can render without recomputing user lists each request.
	if (eventData.type.startsWith('a')) {
		const [users]: [any[], any] = await connection.execute(QUERIES.pastUsers, [eventID]);
		pipeline.hset(`pastEve:${eventID}`, 'users', encode(users.map(user => ({ ...user, age: calculateAge(user.birth) }))));
	}
	await pipeline.exec();
	return meta;
}

// INVALIDATE CACHE -----------------------------------------------------------
// Steps: clear in-process cache entries so the next read falls back to redis/SQL and sees the latest versions.
export const invalidateEventCache = (eventID: number | string) => {
	eventCache.delete(`basi:${eventID}`);
	eventCache.delete(`deta:${eventID}`);
	eventCache.delete(`past:${eventID}`);
};

// GET PAST EVENT --------------------------------------------------------------
// Steps: pick keys to fetch, read from local cache or redis, rebuild from SQL on cache miss, apply rating overlay + privacy filter for users list, then return event blob + users.
async function getPastEvent({ eventID, getBasi, getDeta, gotSQL, con, userID, isFriendly, isOwn, gotUsers }: FetchProps) {
	const keysToFetch = [getBasi && 'basi', getDeta && 'deta', isFriendly && !gotUsers && 'users'].filter(Boolean) as string[];

	// LOCAL/REDIS FETCH ------------------------------------------------------
	// Steps: serve from local cache when it fully covers the requested keys; otherwise fetch only missing keys from redis; never let a partial local entry block redis.
	let cachedData: any[] = [];
	const localKey = `past:${eventID}`;
	const localHit = eventCache.get(localKey) || null;

	// BUFFER MAP BUILD ------------------------------------------------------
	// Steps: normalize local cache shape into a predictable per-key buffer map; this lets us fetch only the missing keys from redis without reordering hazards.
	const bufferByKey: Record<string, any> = {};
	if (localHit) keysToFetch.forEach(key => (bufferByKey[key] = localHit[key]));

	// REDIS FILL ------------------------------------------------------------
	// Steps: hmget only the keys that are missing in local cache; then rebuild the ordered `cachedData` array aligned with `keysToFetch`.
	const redisKeysToFetch = keysToFetch.filter(key => !bufferByKey[key]);
	if (redisKeysToFetch.length) {
		const redisBuffers: Buffer[] = await (redis as any).hmgetBuffer(`pastEve:${eventID}`, ...redisKeysToFetch);
		redisKeysToFetch.forEach((key, index) => (bufferByKey[key] = redisBuffers[index]));
	}
	cachedData = keysToFetch.map(key => bufferByKey[key]);

	// CACHE MISS HANDLING ----------------------------------------------------
	// Steps: if any requested field is missing, rebuild the past event entry from SQL so redis becomes complete again.
	if (cachedData.some(value => !value)) {
		await cachePastEvent(eventID, con);

		// REDIS REFILL AFTER REBUILD ---------------------------------------
		// Steps: refetch the missing keys from redis after rebuild (keeps this path minimal and avoids unnecessary hmget for already-present buffers).
		const missingKeysAfterRebuild = keysToFetch.filter((key, index) => !cachedData[index]);
		if (missingKeysAfterRebuild.length) {
			const rebuiltBuffers: Buffer[] = await (redis as any).hmgetBuffer(`pastEve:${eventID}`, ...missingKeysAfterRebuild);
			missingKeysAfterRebuild.forEach((key, index) => (bufferByKey[key] = rebuiltBuffers[index]));
			cachedData = keysToFetch.map(key => bufferByKey[key]);
		}
	}

	// DECODE ---------------------------------------------------------------
	// Steps: decode only requested buffers; always provide stable defaults so downstream spreads and merges remain safe even when caller didn't request parts.
	const decodedData: any = { basi: {}, deta: {}, users: [] };
	keysToFetch.forEach((key, index) => (decodedData[key] = cachedData[index] ? decode(cachedData[index]) : key === 'users' ? [] : {}));

	// STORE BUFFERS ---------------------------------------------------------
	// Steps: store buffers (not decoded objects) so local path stays consistent with redis path; merge into existing local entry so partial reads accumulate safely.
	if (keysToFetch.length) {
		const mergedLocalPastEntry = localHit || {};
		keysToFetch.forEach((key, index) => (mergedLocalPastEntry[key] = cachedData[index] || mergedLocalPastEntry[key]));
		eventCache.set(localKey, mergedLocalPastEntry);
	}

	const [rating, users] = await Promise.all([
		gotSQL ? {} : getEventRating(con, userID, eventID),
		!isOwn && isFriendly ? checkRedisAccess({ items: decodedData.users || [], userID }) : decodedData.users || [],
	]);
	return [{ ...decodedData.basi, ...decodedData.deta, ...rating }, users.filter((user: any) => user?.id)];
}

// GET FUTURE EVENT ------------------------------------------------------------
// Steps: read basi/deta from local cache or redis hashes, optionally overlay rating from SQL for unstable devices, then merge into a single event object.
async function getFutureEvent({ eventID, getBasi, getDeta, devIsStable, userID, gotSQL, con }: FetchProps) {
	// LOCAL CACHE KEYS -------------------------------------------------------
	// Steps: compute cache keys once; basi/deta are cached independently so partial reads stay cheap.
	const basiKey = `basi:${eventID}`;
	const detaKey = `deta:${eventID}`;

	let basicsData = getBasi ? eventCache.get(basiKey) : undefined;
	let detailsData = getDeta ? eventCache.get(detaKey) : undefined;

	const promises: Promise<any>[] = [];
	if (getBasi && !basicsData) promises.push(redis.hgetall(`${REDIS_KEYS.eveBasics}:${eventID}`).then((d: any) => (eventCache.set(basiKey, d), d)));
	else promises.push(Promise.resolve(basicsData || {}));

	if (getDeta && !detailsData) promises.push(redis.hgetall(`${REDIS_KEYS.eveDetails}:${eventID}`).then((d: any) => (eventCache.set(detaKey, d), d)));
	else promises.push(Promise.resolve(detailsData || {}));

	if (!devIsStable && !gotSQL) promises.push(getEventRating(con, userID, eventID));
	else promises.push(Promise.resolve({}));

	const [resBasi, resDeta, ratingData] = await Promise.all(promises);
	return { ...resBasi, ...resDeta, ...ratingData };
}

// GET FUTURE ATTENDEES --------------------------------------------------------
// Steps: compare lastUsersSync with redis change watermark; if stale, read attendee ids, then filter by privacy (unless owner) and return ids + fresh sync time.
async function getFutureAttendees({ eventID, userID, isOwn, lastUsersSync }: FetchProps) {
	const lastChange: string | null = await redis.hget(REDIS_KEYS.eveLastAttendChangeAt, String(eventID));

	// If client has up-to-date list, return sync timestamp only
	if (lastUsersSync && lastChange && lastUsersSync >= Number(lastChange)) return { usersSync: Number(lastChange) };

	// Get all scored users, filter by privacy access
	const rawItems: { id: string; priv: string }[] = (await redis.zrange(`${REDIS_KEYS.friendlyEveScoredUserIDs}:${eventID}`, 0, -1)).map((item: string) => {
		const [id, priv] = item.split('_');
		return { id, priv };
	});
	const visibleItems: any[] = isOwn ? rawItems : await checkRedisAccess({ items: rawItems, userID });
	return { userIDs: (visibleItems || []).map((item: any) => item?.id).filter(Boolean), usersSync: Date.now() };
}

// EVENT ROUTER ---
// Steps: load meta (redis or past cache), decide past/future, enforce access, decide which parts are stale by version/state, fetch event data and (optional) users list, then respond with a minimal payload.
export async function Event(req: { body: EventRequest }, res: any) {
	let connection: any;
	try {
		const { eventID, userID, gotUsers, devIsStable, state, basiVers, detaVers, getBasiOnly, gotSQL, lastUsersSync } = req.body;

		// META LOAD -----------------------------------------------------------
		// Steps: try meta from redis first; if missing or event is past, open SQL and ensure past cache is hydrated.
		let meta: any[] | null = await (redis as any).hgetBuffer(REDIS_KEYS.eveMetas, eventID).then((buffer: Buffer | null) => (buffer ? decode(buffer) : null));
		if ((!meta && userID) || (meta && isEventPast(meta))) {
			connection = await Sql.getConnection();
			if (!meta)
				meta = (await (redis as any).hgetBuffer(`pastEve:${eventID}`, 'meta').then((buffer: Buffer | null) => (buffer ? decode(buffer) : null))) || (await cachePastEvent(eventID, connection));
		}
		if (!meta) throw new Error('notFound');

		// ACCESS CONTROL ------------------------------------------------------
		// Steps: derive priv/owner/type from meta, compute isOwn/isFriendly, then enforce privacy gates using redis-backed access checks.
		const [priv, owner, type, curBasiVers, curDetaVers] = [evePrivIdx, eveOwnerIdx, eveTypeIdx, eveBasiVersIdx, eveDetailsVersIdx].map(idx => meta![idx]);
		const [isFriendly, isOwn] = [type.startsWith('a'), owner === userID];

		if ((!isOwn && !(await checkRedisAccess({ items: [{ id: eventID, priv, owner }], userID })).length) || (!isOwn && !userID && (priv !== 'pub' || isFriendly))) throw new Error('unauthorized');

		// FETCH SHAPE ---------------------------------------------------------
		// Steps: compute which blobs (basi/deta/users) are needed based on client versions and requested state; avoids over-fetching.
		const fetchProps: FetchProps = {
			eventID,
			getBasi: !!((basiVers && curBasiVers !== basiVers) || getBasiOnly || (state && !state.includes('basi'))),
			getDeta: !!((detaVers && curDetaVers !== detaVers) || (!getBasiOnly && state && !state.includes('Deta'))),
			devIsStable,
			userID,
			gotUsers,
			lastUsersSync,
			gotSQL,
			isOwn,
			con: connection,
			isFriendly,
		};

		if (!gotSQL && !devIsStable && !connection) connection = await Sql.getConnection();
		fetchProps.con = connection; // Ensure connection is passed if created

		// ROUTE EXECUTION -----------------------------------------------------
		// Steps: for past events, read past cache + optional users; for future, read hashes + optional attendees list (for friendly events).
		const [eventData, attendeeSync, pastUsers]: [any, any, any] = isEventPast(meta)
			? [...(await getPastEvent(fetchProps))]
			: [await getFutureEvent(fetchProps), isFriendly && !gotUsers && (await getFutureAttendees(fetchProps)), undefined];

		if (!eventData) throw new Error('badRequest');

		res.status(200).json(
			delFalsy({
				eventData,
				eveMeta: state === 'noMeta' ? meta : null,
				userIDs: attendeeSync?.userIDs,
				pastUsers,
				usersSync: attendeeSync?.usersSync,
			})
		);
	} catch (error: any) {
		logger.error('Event', { error: error, ...req.body });
		Catcher({ origin: 'Event', error: error, res });
	} finally {
		// CLEANUP --------------------------------------------------------------
		// Steps: release SQL connection when acquired so the pool stays healthy.
		connection?.release();
	}
}
