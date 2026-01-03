import { decode, encode } from 'cbor-x';
import { getOrSaveCityData } from '../../utilities/helpers/location.ts';
import { getOrCacheFilteringSets } from '../../utilities/helpers/cache.ts';
import { LRUCache } from 'lru-cache';

import { USER_META_INDEXES, REDIS_KEYS, FOUNDATION_LOADS } from '../../../shared/constants.ts';
const { userAttendIdx } = USER_META_INDEXES;

import { Sql } from '../../systems/systems.ts';
import { getLogger } from '../../systems/handlers/logging/index.ts';
import { redis } from './utils.ts';
// NOTE: type-only imports removed (minimal backend typing).

const logger = getLogger('FoundationContent');

// NOTE: local foundation/content type aliases removed (minimal backend typing).

// CITY DATA CACHE -------------------------------------------------------------
// Steps: on each request we first try this tiny in-process cache, then hit Redis only
// for misses; this collapses read bursts for hot cities without changing correctness
// because the underlying source-of-truth remains Redis (with short TTL here).
const cityCache = new LRUCache({
	max: 5000,
	ttl: 5 * 60 * 1000, // 5 minute TTL matches typical task intervals
	updateAgeOnGet: false, // Ensure data refreshes from Redis eventually
});

// USER SETS CACHE -------------------------------------------------------------
// Steps: caching user's blocks/links sets to avoid fetching them on every request.
// Timestamps in Redis ensure synchronization.
const userSetCache = new LRUCache({
	max: 10000, // 1000 users/sets
	ttl: 30 * 60 * 1000, // 30 minutes
	updateAgeOnGet: false, // Ensure data refreshes from Redis eventually
});

// CITY FILTERING PARSER ---
// Steps: parse and optimize city filtering maps into a structure that minimizes iteration loops.
// Returns: { byOwner: Map<ownerID, {id, priv}[]>, ind: {id, privs}[] }
function parseCityFiltering(filtering) {
	const byOwner = new Map();
	const ind = [];
	if (!filtering) return { byOwner, ind };

	for (const [id, info] of Object.entries(filtering)) {
		const [priv, ownerOrPrivs] = String(info).split(':');

		if (priv === 'ind') {
			const privs = ownerOrPrivs ? ownerOrPrivs.split(',').filter(Boolean) : [];
			ind.push({ id: String(id), privs });
		} else {
			const owner = String(ownerOrPrivs || id);
			const list = byOwner.get(owner) || [];
			list.push({ id: String(id), priv });
			byOwner.set(owner, list);
		}
	}
	return { byOwner, ind };
}

// GET USER SET ---
// Steps: first attempt LRU cache read; only then fetch Redis timestamp watermark and decide whether cached data is still valid.
// If timestamp is missing, rebuild set from SQL (and cache into Redis) then write a fresh ts watermark; otherwise serve from local cache when ts matches, else reload from Redis and cache.
async function getUserSet(con, userID, type) {
	// LRU CACHE FAST PATH ---
	// Steps: attempt local cache first to avoid Redis work when the timestamp matches.
	const cached = userSetCache.get(`${type}:${userID}`);

	// TIMESTAMP RESOLUTION ---
	// Steps: fetch the authoritative watermark only after local cache attempt.
	const tsNumber = Number(await redis.hget(`${REDIS_KEYS.userSetsLastChange}:${userID}`, type));

	// NO TIMESTAMP: FORCE REBUILD ---
	// Steps: treat missing watermark as unsynced; rebuild from SQL, cache to Redis, then establish a fresh watermark.
	if (!tsNumber) {
		const set = await getOrCacheFilteringSets(con, type, userID, true); // caches in Redis
		const newTs = Date.now(); // local monotonic marker; authoritative watermark is stored in Redis
		await redis.hset(`${REDIS_KEYS.userSetsLastChange}:${userID}`, type, newTs);
		userSetCache.set(`${type}:${userID}`, { set, ts: newTs });
		return set;
	}

	// TIMESTAMP MATCH: RETURN CACHED ---
	// Steps: if cached watermark matches, return cached set without any Redis smembers read.
	if (cached && cached.ts === tsNumber) return cached.set;

	const members = await redis.smembers(`${type}:${userID}`);
	const set = new Set(members);
	userSetCache.set(`${type}:${userID}`, { set, ts: tsNumber });
	return set;
}

// PROCESS CONTENT METAS ---
// Steps: optionally resolve city objects -> cityIDs, then fetch per-city filtering indexes,
// then compute which non-public items *might* be visible, then batch-resolve permissions,
// then fetch heavy non-public metas only for items that actually passed, then merge with
// public metas while enforcing blocks and per-attendance privacy.
async function processContentMetas({ con, load, getCities, cities, userID }) {
	let contentMetas,
		citiesData,
		contSync = Date.now();

	if (load === FOUNDATION_LOADS.fast) return { contentMetas, citiesData, contSync };

	try {
		// CITY RESOLUTION ---
		// Steps: if caller supplied city objects, normalize them into stable cityIDs so all downstream Redis keys are deterministic.
		if (getCities.length) citiesData = await getOrSaveCityData((con ??= await Sql.getConnection()), getCities);

		if (load === FOUNDATION_LOADS.topEvents) {
			// SPECIAL MODE: GLOBAL TOP EVENTS ---
			// Steps: bypass city hints entirely and read the one shared “best of” map.
			contentMetas = [await redis.hgetallBuffer(REDIS_KEYS.topEvents)];
			contentMetas[0].cityID = REDIS_KEYS.topEvents;
		} else {
			// STANDARD MODE: PER-CITY PIPELINE ---
			// Steps: build the full city list, then stage reads in bulk so Redis roundtrips stay bounded.
			const [getFilteringMapsPipe, getPublicMetasPipe] = [redis.pipeline(), redis.pipeline()];
			const cityIDs = [...new Set(cities.filter(c => typeof c === 'number').concat(citiesData?.map(c => c.cityID) || []))];
			const cityIDStrings = cityIDs.map(id => String(id));

			// PERMISSION KEY ACCUMULATION ---
			// Steps: collect keys we must verify (links/trusts/invites) so we can do one batched smismember pass later.
			const [allLinKeys, allTruKeys, allInvKeys, ownEve] = [new Set(), new Set(), new Set(), new Set()];
			const addKey = (p, key) => ({ lin: allLinKeys, tru: allTruKeys, inv: allInvKeys }[p]?.add(key));

			// CACHE CHECK + FETCH QUEUE ---
			// Steps: for each city, try process cache first; for misses, queue pipeline reads and remember which indices to fill.
			const filteringMapsResult = new Array(cityIDs.length);
			const publicMetasResult = new Array(cityIDs.length);
			const missingIndices = [];

			for (let i = 0; i < cityIDs.length; i++) {
				const id = cityIDStrings[i];
				const cachedFiltering = cityCache.get(`filtering:${id}`);
				const cachedPubMetas = cityCache.get(`pubMetas:${id}`);

				if (cachedFiltering && cachedPubMetas) {
					filteringMapsResult[i] = [null, cachedFiltering];
					publicMetasResult[i] = [null, cachedPubMetas];
				} else {
					missingIndices.push(i);
					getFilteringMapsPipe.hgetall(`${REDIS_KEYS.cityFiltering}:${id}`);
					getPublicMetasPipe.hgetallBuffer(`${REDIS_KEYS.cityPubMetas}:${id}`);
				}
			}

			if (missingIndices.length) {
				// PIPELINE FLUSH ---
				// Steps: execute once, then stitch results back into their original city order, then populate cache on success.
				const [fRes, pRes] = await Promise.all([getFilteringMapsPipe.exec(), getPublicMetasPipe.exec()]);

				for (let j = 0; j < missingIndices.length; j++) {
					const idx = missingIndices[j];
					const id = cityIDStrings[idx];

					// FILTERING MAP NORMALIZATION ---
					// Steps: always normalize raw Redis hash -> parsed structure so downstream logic never needs to branch on cache-hit vs miss.
					const parsedFiltering = fRes[j]?.[1] ? parseCityFiltering(fRes[j][1]) : null;
					filteringMapsResult[idx] = [fRes[j]?.[0], parsedFiltering];
					publicMetasResult[idx] = pRes[j];

					// POPULATE CACHE ON SUCCESS ---
					// Steps: reuse already-parsed filtering to avoid double work; cache only when Redis returned data without error.
					if (!fRes[j][0] && parsedFiltering) cityCache.set(`filtering:${id}`, parsedFiltering);
					if (!pRes[j][0] && pRes[j][1]) cityCache.set(`pubMetas:${id}`, pRes[j][1]);
				}
			}

			// TODO implement a conditional for fetching whole sets / vs using redis inbuilt ismember function. Probably base it on cityMetash hash size (cache that as well). after certain threshold, we always fetch and cache sets. if there is a small number of content, its better to send IDs to Redis

			// USER SETS LOAD (BLOCKS FIRST) ---
			// Steps: BLOCKS are always required, so load them immediately; timestamps are resolved inside getUserSet after LRU attempt.
			const blocks = await getUserSet(con, userID, REDIS_KEYS.blocks);
			let links, trusts, invites;

			// PASS 1: SCAN PRIVACIES RULES ---
			// Steps: scan cityFiltering to build a candidate list and a verification queue; we intentionally do not call smember
			// per item here because that would explode into N*roundtrips.
			const cityData = filteringMapsResult.map(([err, data], i) => {
				if (err || !data) return { error: true, cityID: cityIDs[i] };
				const [passedIDs, indUsers, privChecks] = [[], [], []];

				const { byOwner, ind } = data; // Using optimized parsed structure

				// 1. Process Grouped By Owner
				for (const [owner, events] of byOwner) {
					if (blocks.has(owner)) continue; // Blocked owner: skip all

					const isOwn = owner == userID;
					for (const { id, priv } of events) {
						if (isOwn && !ownEve.has(id)) {
							ownEve.add(id);
							passedIDs.push(id);
						} else {
							privChecks.push([id, priv, owner]);
							addKey(priv, owner);
						}
					}
				}

				// 2. Process Individual Events
				for (const { id, privs } of ind) {
					if (blocks.has(id)) continue;
					indUsers.push(id);
					passedIDs.push(id);
					privs.forEach(priv => addKey(priv, id));
				}

				return { cityID: cityIDs[i], passedIDs, indUsers, privChecks };
			});

			// PASS 2: BATCH RESOLVE PERMISSIONS ---
			// Steps: resolve links/trusts/invites locally using cached sets.
			const [linAccess, truAccess, invAccess] = [new Set(), new Set(), new Set()];

			// PARALLEL PERMISSION SET LOADING ---
			// Steps: load links/trusts/invites in parallel since they are independent; then populate access sets.
			const [linksResult, trustsResult, invitesResult] = await Promise.all([
				allLinKeys.size ? getUserSet(con, userID, REDIS_KEYS.links) : null,
				allTruKeys.size ? getUserSet(con, userID, REDIS_KEYS.trusts) : null,
				allInvKeys.size ? getUserSet(con, userID, REDIS_KEYS.invites) : null,
			]);

			if (linksResult) { links = linksResult; for (const key of allLinKeys) if (links.has(key)) linAccess.add(key); }
			if (trustsResult) { trusts = trustsResult; for (const key of allTruKeys) if (trusts.has(key)) truAccess.add(key); }
			if (invitesResult) { invites = invitesResult; for (const key of allInvKeys) if (invites.has(key)) invAccess.add(key); }

			// PASS 3: FILTER CANDIDATES ---
			// Steps: replay queued checks now that access sets are known; this turns “might pass” into “definitely passes”.
			for (const d of cityData) {
				if (d.error) continue;
				for (const [id, priv, key] of d.privChecks)
					if ((priv === 'lin' && linAccess.has(key)) || (priv === 'tru' && truAccess.has(key)) || (priv === 'inv' && invAccess.has(key))) d.passedIDs.push(id);
			}

			// PASS 4: FETCH NON-PUBLIC DATA ---
			// Steps: only fetch heavy metas for passedIDs to keep Redis payload cost proportional to visible content.
			const nonPubToFetch = [],
				nonPubIndexMap = new Map();
			for (let i = 0; i < cityData.length; i++) if (!cityData[i].error && cityData[i].passedIDs.length) nonPubIndexMap.set(i, nonPubToFetch.push([i, cityData[i]]) - 1);

			const nonPubPipe = redis.pipeline();
			// REDIS KEY FIX ------------------------------------------------------
			for (const [, d] of nonPubToFetch) nonPubPipe.hmgetBuffer(`${REDIS_KEYS.cityMetas}:${d.cityID}`, ...d.passedIDs.map(String));
			const nonPubResults = await nonPubPipe.exec();

			// PASS 5: FINAL ASSEMBLY ---
			// Steps: merge non-public metas into the city map, then apply per-attendance filtering for “ind” users, then layer public metas
			// while still respecting blocks (public does not mean “ignores block”).
			contentMetas = new Array(cityData.length);
			for (let i = 0; i < cityData.length; i++) {
				const d = cityData[i];
				if (d.error) {
					contentMetas[i] = { cityID: d.cityID, error: true };
					continue;
				}

				let metas = [];
				if (nonPubIndexMap.has(i)) {
					const [err, arr] = nonPubResults[nonPubIndexMap.get(i)] || [null, []];
					if (err) {
						contentMetas[i] = { cityID: d.cityID, error: true };
						continue;
					}
					metas = arr;
				}

				const { cityID, passedIDs, indUsers } = d,
					cityMetas = { cityID };

				// NON-PUBLIC MERGE ---
				// Steps: slot ordered `metas` buffers onto their IDs; later filters may delete some entries.
				for (let j = 0; j < passedIDs.length; j++) cityMetas[passedIDs[j]] = metas[j];

				// INDIVIDUAL META FILTER ---
				// Steps: decode, filter embedded attendance list by per-event privacy, then re-encode; delete the entry if it becomes empty.
				for (const id of indUsers) {
					try {
						const meta = decode(cityMetas[id]);
						// ATTENDANCE ACCESS ------------------------------------------------
						// We intentionally use a mutable array view for attendance reads/writes.
						const metaArray = meta;
						metaArray[userAttendIdx] = metaArray[userAttendIdx].filter(
							([eveID, , evePriv]) => !evePriv || evePriv === 'pub' || (evePriv === 'lin' && linAccess.has(id)) || (evePriv === 'tru' && truAccess.has(id)) || ownEve.has(eveID)
						);
						if (metaArray[userAttendIdx].length) cityMetas[id] = encode(metaArray);
						else delete cityMetas[id];
					} catch (error) {
						logger.error('Foundation', { error, userID, step: 'filterCityMeta', cityID, metaId: id });
						delete cityMetas[id];
					}
				}

				// PUBLIC LAYER ---
				// Steps: public metas are still gated by the filtering index + blocks, then appended onto the same cityMetas map.
				const [, pubMap] = publicMetasResult[i] || [],
					[, filtering] = filteringMapsResult[i] || [];

				if (pubMap && filtering) {
					const { byOwner } = filtering;
					for (const [owner, events] of byOwner) {
						if (blocks.has(owner)) continue;
						for (const { id, priv } of events) {
							if (priv === 'pub') {
								const buf = pubMap[id];
								if (buf) cityMetas[id] = buf;
							}
						}
					}
				}
				contentMetas[i] = cityMetas;
			}
		}
	} catch (error) {
		logger.error('Foundation', { error, userID, step: 'processContentMetas' });
	}

	return { contentMetas, citiesData, contSync };
}

export { processContentMetas };
