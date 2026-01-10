import { delFalsy, calculateAge } from '../../shared/utilities.ts';
import { createEveMeta, createUserMeta } from './helpers/metasCreate.ts';
import { encode, decode } from 'cbor-x';
import { getLogger } from '../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../shared/constants.ts';
import { getGeohash } from './helpers/location.ts';

const logger = getLogger('ContentHelpers');

// CONSTANTS & INDICES --------------------------------------------------------
import { EVENT_META_INDEXES, USER_META_INDEXES } from '../../shared/constants.ts';
const { evePrivIdx, eveCityIDIdx, eveOwnerIdx, eveTypeIdx, eveSurelyIdx, eveMaybeIdx } = EVENT_META_INDEXES;
const { userPrivIdx, userScoreIdx, userAttendIdx } = USER_META_INDEXES;

let redis;
let geohash = null;

// REDIS CLIENT SETTER ----------------------------------------------------------
export const ioRedisSetter = c => (redis = c);

// MAP INITIALIZERS -------------------------------------------------------------
// Steps: centralize “get or create” patterns so the hot loops don’t repeat boilerplate and don’t accidentally allocate multiple containers per key.
const getMap = (map, key) => map.get(key) || (map.set(key, new Map()), map.get(key));
const getArr = (map, key) => map.get(key) || (map.set(key, []), map.get(key));

// STATE VARIABLES --------------------------
// Steps: allocate a fresh state container used by boot rebuild + recalc tasks; these maps get progressively filled, then flushed into Redis.
const getStateVariables = () => ({
	cityMetas: new Map(),
	cityPubMetas: new Map(),
	cityFiltering: new Map(),
	eveCityIDs: new Map(),
	friendlyEveScoredUserIDs: new Map(),
	eveMetas: new Map(),
	eveBasics: new Map(),
	eveDetails: new Map(),
	userMetas: new Map(),
	userBasics: new Map(),
	best100EveIDs: new Set(),
	remEve: new Set(),
});

// NEW EVENTS PROCESSING --------------------------------------------------------
// Steps: for each DB event row, split heavy vs indexable fields, build compact meta array, then populate basics/ils maps;
// mutate `data` in-place into `[id, meta]` so downstream processors can be generic and avoid re-destructuring.
async function processNewEvents({ data, state: { eveBasics, eveDetails, eveCityIDs, best100EveIDs }, newEventsProcessor }) {
	geohash ??= getGeohash();
	const packed = [];
	data.forEach((eventRow, idx) => {
		const { id, priv, cityID, type, starts, lat, lng, surely, maybe, score, comments, basiVers, detaVers, ...rest } = eventRow;
		const eventIDString = String(id);
		const owner = rest.owner?.startsWith('orphaned') ? 'orphaned' : rest.owner;
		const { meetHow, meetWhen, organizer, contacts, links, detail, fee, takeWith, place, location, hashID, ...basics } = rest;

		if (basics.flag === 'can') basics.canceled = true;

		// META PACKING ---
		// Steps: pack into fixed index positions so privacy filtering is array-index based rather than object-key based.
		const startsBase36 = new Date(starts).getTime().toString(36);
		packed[idx] = [id, createEveMeta({ priv, owner, cityID, type, starts: startsBase36, geohash: geohash.encode(lat, lng, 9), surely, maybe, comments, score, basiVers, detaVers })];

		eveBasics.set(
			eventIDString,
			delFalsy({ ...basics, basiVers: Number(basiVers), ...(place || location ? { ...(place ? { place } : { location }), hashID } : {}), ends: Number(new Date(basics.ends)) })
		);
		eveDetails.set(
			eventIDString,
			delFalsy({
				meetHow,
				meetWhen: meetWhen ? Number(new Date(meetWhen)) : undefined,
				organizer,
				contacts,
				location,
				links,
				detail,
				fee,
				takeWith,
				detaVers: Number(detaVers),
				...(place ? { location } : {}),
			})
		);
		eveCityIDs.set(eventIDString, Number(cityID));

		// BEST-OF CANDIDATES ---
		// Steps: opportunistically fill best100 set from public, non-archive-ish event types to avoid a second pass.
		if (best100EveIDs.size < 100 && priv === 'pub' && !type.startsWith('a')) best100EveIDs.add(id);
	});
	await newEventsProcessor({ data: packed });
}

// NEW USERS PROCESSING ---------------------------------------------------------
// Steps: derive computed fields (age + attendance arrays), pack into compact user meta arrays, then store basi payloads;
// attendance parsing is done here to avoid repeated joins/expansion during hot path reads.
async function processNewUsers({ data, state: { userBasics }, userMetasProcessor }) {
	const today = Date.now();
	const packed = [];
	data.forEach((userRow, idx) => {
		const { id, priv, score, birth, gender, basiVers, imgVers, eveInterPriv, indis, basics, groups, ...rest } = userRow;
		const userIDString = String(id);

		const attend =
			eveInterPriv?.split(',').map(e => {
				const [eid, inter, ep] = e.split(':');
				return [eid, inter, ...(priv === 'ind' && ep !== 'pub' ? [ep] : [])];
			}) ?? [];

		const age = calculateAge(birth, today);
		packed[idx] = [id, createUserMeta({ priv, age, gender, indis, basics, groups, score, imgVers, basiVers, attend })];
		userBasics.set(userIDString, { ...rest, basiVers });
	});
	await userMetasProcessor({ data: packed, is: 'new' });
}

// EVENT META PROCESSING -------------------------------------------------------
// Steps: process event metas into city maps + filtering maps.
const processEveMetas = (data, { eveMetas, cityMetas, cityPubMetas, cityFiltering, eveCityIDs }, metaType) =>
	data.forEach(([id, meta]) => {
		const eventIDString = String(id);
		if (metaType === 'orp') meta[eveOwnerIdx] = 'orphaned';

		const [metaBuffer, cityID, priv, owner] = [encode(meta), meta[eveCityIDIdx], meta[evePrivIdx], meta[eveOwnerIdx]];
		const cityIDString = String(cityID);

		// CITY ROUTING ---
		// Steps: public metas go into pub map; everything else goes into private map, and filtering map records the gate string.
		getMap(priv === 'pub' ? cityPubMetas : cityMetas, cityIDString).set(eventIDString, metaBuffer);
		getMap(cityFiltering, cityIDString).set(eventIDString, metaType === 'orp' ? `${priv}:orphaned` : `${priv}:${owner}`);
		eveMetas.set(eventIDString, metaBuffer);
		if (metaType === 'new') eveCityIDs.set(eventIDString, Number(cityID));
	});

// CONTEXT WRAPPERS ------------------------------------------------------------
// Steps: keep callsites readable by binding the `metaType` once.
const processOrpEveMetas = p => processEveMetas(p.data, p.state, 'orp');
const processRecEveMetas = p => processEveMetas(p.data, p.state, 'rec');
const processNewEveMetas = p => processEveMetas(p.data, p.state, 'new');

// REMOVED EVENTS PROCESSING -------------------------------------------------
// Steps: remove event from city maps + event keys, then for friendly events recalc impacted users by re-processing their metas.
const keys = [REDIS_KEYS.eveMetas, REDIS_KEYS.eveBasics, REDIS_KEYS.eveDetails, REDIS_KEYS.friendlyEveScoredUserIDs],
	hKeys = [REDIS_KEYS.eveTitleOwner, REDIS_KEYS.eveCityIDs, REDIS_KEYS.eveLastCommentAt, REDIS_KEYS.eveLastAttendChangeAt, REDIS_KEYS.topEvents, REDIS_KEYS.newEveCommsCounts];

// NOTE: ProcessRemEveMetasInput typing removed (minimal backend typing).

async function processRemEveMetas({ data, state: { remEve, eveCityIDs, cityMetas, cityPubMetas, cityFiltering }, deletionsPipe: pipe, userMetasProcessor }) {
	for (const [id, meta] of data) {
		const [eventCityID, eventType] = [meta[eveCityIDIdx], meta[eveTypeIdx]];
		const [eventIDString, eventCityIDString] = [String(id), String(eventCityID)];
		remEve.add(id);

		// DELETE QUEUE ---
		// Steps: delete from memory first, then queue Redis deletions into the caller pipeline for atomic-ish flush.
		[cityMetas, cityPubMetas, cityFiltering].forEach(map => map.get(eventCityIDString)?.delete(eventIDString));
		[REDIS_KEYS.cityMetas, REDIS_KEYS.cityPubMetas, REDIS_KEYS.cityFiltering].forEach(k => pipe.hdel(`${k}:${eventCityIDString}`, eventIDString));
		keys.forEach(k => pipe.del(`${k}:${eventIDString}`));
		hKeys.forEach(k => pipe.hdel(k, eventIDString));

		// USER RECALC (FRIENDLY EVENTS) ---
		// Steps: friendly events have user meta ties; rebuild those users so derived indexes remain consistent.
		if (eventType.startsWith('a')) {
			try {
				const userIDs = (await redis.zrange(`${REDIS_KEYS.friendlyEveScoredUserIDs}:${id}`, 0, -1)).map(s => s.split('_')[0]);
				if (!userIDs.length) continue;
				const users = (await redis.hmgetBuffer(REDIS_KEYS.userMetas, ...userIDs)).map((mb, i) => (mb ? [userIDs[i], decode(mb)] : null)).filter(Boolean);
				eveCityIDs.set(eventIDString, Number(eventCityID));
				if (users.length) await userMetasProcessor({ data: users, is: 'rec' });
			} catch (e) {
				logger.error('contentHelpers.process_event_users_failed', { error: e, eventId: id });
			}
		}
	}
}

// USER META PROCESSING ------------------------------------------------------
// Updates user metas, handles attendance changes, and syncs city lists
const userKeys = [REDIS_KEYS.userBasics, REDIS_KEYS.tempProfile, REDIS_KEYS.blocks, REDIS_KEYS.links, REDIS_KEYS.invites, REDIS_KEYS.userSummary, REDIS_KEYS.trusts, REDIS_KEYS.userActiveChats],
	userMapKeys = [REDIS_KEYS.userMetas, REDIS_KEYS.userNameImage, REDIS_KEYS.userChatRoles];

// Helper: Add user score to Redis sorted set
// USER SCORE INDEXING ----------------------------------------------------------
const addScored = (meta, eveID, id, inter, priv, map) => {
	const score = Number(meta[userScoreIdx] ?? 0);
	getArr(map, eveID).push(inter === 'sur' ? 1 + score / 1000 : score / 1000, `${id}${priv ? `_${priv}` : !['pub', 'ind'].includes(meta[userPrivIdx]) ? `_${meta[userPrivIdx]}` : ''}`);
};

// USER META PIPELINE ---
// Steps: for each user meta, detach attendance array, apply diffs (newAttenMap / removals / priv changes), rebuild scored sets,
// then fan the user meta back into per-city maps and filtering indexes.
async function processUserMetas({ data, is, newAttenMap, privUse, state, pipe }) {
	const { eveCityIDs, remEve, cityMetas, cityPubMetas, userMetas, friendlyEveScoredUserIDs, cityFiltering } = state,
		missed = new Set<string | number>(),
		localPipe = pipe || redis?.pipeline();

	for (const [id, meta] of data) {
		try {
			const userIDString = String(id);

			const userPrivValue = String(meta[userPrivIdx] ?? '');
			let attend = meta[userAttendIdx] ?? [],
				newAtt = newAttenMap?.get(userIDString);
			if (meta.length && Array.isArray(attend)) meta.length--; // Detach for processing

			// Update attendance if changed or new
			if (newAtt || is !== 'rec') {
				// Process existing attendances (reverse loop for safe splice)
				for (let i = attend.length - 1; i >= 0; i--) {
					const [eveID, inter, evePriv] = attend[i],
						city = eveCityIDs.get(String(eveID));
					if (!city) {
						missed.add(eveID);
						continue;
					}

					if (newAtt) {
						// Handle intersection with new data
						const [newInter, newPriv] = newAtt.get(String(eveID)) || [];
						if (!newInter) continue;
						newAtt.delete(String(eveID));
						if (!['sur', 'may'].includes(newInter)) {
							attend.splice(i, 1);
							localPipe?.zrem(`${REDIS_KEYS.friendlyEveScoredUserIDs}:${eveID}`, `${userIDString}${evePriv || !['pub', 'ind'].includes(userPrivValue) ? `_${userPrivValue}` : ''}`);
						} else {
							attend[i] = [eveID, newInter, ...(userPrivValue === 'ind' && newPriv ? [newPriv] : [])];
							addScored(meta, eveID, userIDString, newInter, newPriv, friendlyEveScoredUserIDs);
						}
					} else if (remEve.has(eveID)) attend.splice(i, 1); // Remove deleted events
					else if (is === 'rem') {
						// Decrement event counts if removed
						let em = state.eveMetas.get(eveID);
						if (!em) {
							const b = await redis.hgetBuffer(REDIS_KEYS.eveMetas, String(eveID));
							if (b) (em = decode(b)), em[inter === 'sur' ? eveSurelyIdx : eveMaybeIdx]--, state.eveMetas.set(eveID, em);
						} else em[inter === 'sur' ? eveSurelyIdx : eveMaybeIdx]--;
						localPipe?.zrem(`${REDIS_KEYS.friendlyEveScoredUserIDs}:${eveID}`, `${userIDString}${evePriv ? `_${evePriv}` : ''}`);
					} else if (is === 'new') addScored(meta, eveID, userIDString, inter, evePriv, friendlyEveScoredUserIDs);
				}
				// Add completely new attendances
				if (newAtt?.size)
					for (const [eventID, [inter, interPriv]] of newAtt) {
						if (['sur', 'may'].includes(inter)) {
							attend.push([eventID, inter, ...(userPrivValue === 'ind' && interPriv ? [interPriv] : [])]);
							addScored(meta, eventID, userIDString, inter, interPriv, friendlyEveScoredUserIDs);
						}
					}
			}

			// Finalize user meta and distribute to cities
			if (is !== 'rem' && attend.length) {
				if (missed.size)
					try {
						const missedArr = [...missed];
						const results = await redis.hmget(REDIS_KEYS.eveCityIDs, ...missedArr.map(String));
						results.forEach((c, i) => c && eveCityIDs.set(String(missedArr[i]), Number(c)));
					} catch (e) {
						logger.error('contentHelpers.fetch_city_ids_failed', { error: e });
					}

				const filtered = new Map(),
					newPriv = privUse?.get(id);
				// Partition attendance by city
				for (const arr of attend) {
					const cityID = eveCityIDs.get(String(arr[0]));
					if (!cityID) continue;
					if (is === 'pri') {
						const [eventID, interest, attenPriv] = arr,
							key = attenPriv ? `${userIDString}_${attenPriv}` : userIDString;
						if (attenPriv && newPriv === 'ind') arr.pop();
						localPipe?.zrem(`${REDIS_KEYS.friendlyEveScoredUserIDs}:${eventID}`, key);
						addScored(meta, eventID, userIDString, interest, attenPriv, friendlyEveScoredUserIDs);
					}
					getArr(filtered, cityID).push(arr);
				}

				if (is === 'pri') meta[userPrivIdx] = newPriv;
				userMetas.set(userIDString, encode(meta.concat([attend])));

				// Store filtered metas per city
				filtered.forEach((cityAtten, cityID) => {
					const uniquePrivs = [...new Set(cityAtten.filter(([, , p]) => p && p !== 'pub').map(([, , p]) => p))];
					const finalPriv =
						userPrivValue === 'ind' && cityAtten && uniquePrivs.length
							? uniquePrivs.length === 1
								? uniquePrivs[0]
								: `ind:${uniquePrivs.join(',')}`
							: userPrivValue === 'ind'
							? 'pub'
							: userPrivValue;

					const cityIDString = String(cityID);
					getMap(finalPriv === 'pub' ? cityPubMetas : cityMetas, cityIDString).set(userIDString, encode(meta.concat([cityAtten ?? []])));
					getMap(cityFiltering, cityIDString).set(userIDString, String(finalPriv));
				});
			} else if (redis) {
				// Cleanup user if no attendance remains
				const cityIDs = new Set(attend.map((a: any[]) => eveCityIDs.get(a[0])).filter(Boolean));
				for (const cityID of cityIDs) {
					const cityIDString = String(cityID);
					[cityMetas, cityPubMetas, cityFiltering].forEach(map => map.get(cityIDString)?.delete(userIDString));
					[REDIS_KEYS.cityMetas, REDIS_KEYS.cityPubMetas, REDIS_KEYS.cityFiltering].forEach(k => localPipe?.hdel(`${k}:${cityIDString}`, userIDString));
				}
				userKeys.forEach(k => localPipe?.del(`${k}:${userIDString}`));
				userMapKeys.forEach(k => localPipe?.hdel(k, userIDString));
			}
		} catch (e) {
			logger.error('contentHelpers.process_user_meta_failed', { error: e, userId: id });
		}
	}
	if (!pipe && localPipe)
		try {
			await localPipe.exec();
		} catch (e) {
			logger.error('contentHelpers.process_user_metas_transaction_failed', { error: e });
		}
}

// PIPELINE FILLING ----------------------------------------------------------
// Steps: flatten accumulated state maps into Redis hset/zadd operations; caller controls pipeline lifetime and exec timing.
function loadMetaPipes({ eveMetas, eveCityIDs, userMetas, friendlyEveScoredUserIDs, cityMetas, cityPubMetas, cityFiltering, best100EveIDs }, metasPipe, attenPipe, mode) {
	if (mode === 'serverStart' && best100EveIDs.size) {
		const bestEntries = [...best100EveIDs]
			.map(id => [String(id), eveMetas.get(String(id))])
			.filter(([, m]) => m)
			.flat();
		if (bestEntries.length) metasPipe.hset(REDIS_KEYS.topEvents, ...bestEntries);
	}
	[eveMetas, eveCityIDs, userMetas].forEach((map, k) => map.size && metasPipe.hset([REDIS_KEYS.eveMetas, REDIS_KEYS.eveCityIDs, REDIS_KEYS.userMetas][k], ...[...map].flat()));
	for (const [eve, uids] of friendlyEveScoredUserIDs) attenPipe.zadd(`${REDIS_KEYS.friendlyEveScoredUserIDs}:${eve}`, ...uids);
	[cityMetas, cityPubMetas, cityFiltering].forEach((map, i) =>
		map.forEach((m, c) => m.size && metasPipe.hset(`${[REDIS_KEYS.cityMetas, REDIS_KEYS.cityPubMetas, REDIS_KEYS.cityFiltering][i]}:${c}`, ...[...m].flat()))
	);
}

// BASI/DETA FLATTEN ---
// Steps: write object payloads as alternating field/value pairs into per-ID hashes
function loadBasicsDetailsPipe({ eveBasics, eveDetails, userBasics }, pipe) {
	[eveBasics, eveDetails, userBasics].forEach((map, i) =>
		map.forEach((data, id) => pipe.hset(`${[REDIS_KEYS.eveBasics, REDIS_KEYS.eveDetails, REDIS_KEYS.userBasics][i]}:${id}`, ...Object.entries(data).flat()))
	);
}

// CLEAR STATE ---
// Steps: clear all Map/Set containers except the ones explicitly kept; this prevents memory growth during streaming rebuilds.
function clearState(state, keep = []) {
	try {
		const keepSet = new Set(keep);
		Object.entries(state).forEach(([k, v]) => {
			if (keepSet.has(k)) return;
			(v instanceof Map || v instanceof Set) && v.clear();
		});
	} catch (e) {
		logger.error('contentHelpers.clear_state_failed', { error: e });
	}
}

export {
	getStateVariables,
	processNewEvents,
	processNewUsers,
	processRecEveMetas,
	processOrpEveMetas,
	processNewEveMetas,
	processRemEveMetas,
	processUserMetas,
	loadMetaPipes,
	loadBasicsDetailsPipe,
	clearState,
};
