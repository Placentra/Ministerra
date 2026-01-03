import { Catcher, Streamer, Writer } from '../systems/systems';
import { decode } from 'cbor-x';
import { getIDsString } from '../../shared/utilities';
import { getStateVariables, processUserMetas, processNewUsers, loadMetaPipes, loadBasicsDetailsPipe, clearState, processRecEveMetas } from '../utilities/contentHelpers';
import { getLogger } from '../systems/handlers/logging/index';
import { REDIS_KEYS, USER_GENERIC_KEYS } from '../../shared/constants';
import { invalidateEventCache } from '../modules/event';
import { invalidateUserCache } from '../modules/user';

// META INDEXES ------------------------------------------
import { EVENT_META_INDEXES } from '../../shared/constants';
const { eveSurelyIdx, eveMaybeIdx, eveCommentsIdx, eveScoreIdx, eveTypeIdx } = EVENT_META_INDEXES;

const logger = getLogger('Task:UserInteractions');
// tODO invites
// !!!!!!!!!TODO move all posible duplicate sql inset errors into catch block for retry logic and remove it from queries (it will significantly lower the db load)
// TODO store ratings alreadyd calculated and summed up into redis , so that it doesnt have to be eiterated over again here.
// TODO  get rid of the "processors function wrappers" call the processXYXYYX
// TODO when processing ratings, count the occurence of awards and total counts of ratings to send it in alerts too.
// TODO send dlso counts of rewards

// STREAM INPUTS ----------------------------------------------------------------
// These streams carry interaction deltas (ratings, attendance, comment ratings) and are merged here into:
// - SQL write batches (Writer/Querer)
// - content meta rebuild triggers (contentHelpers processors)
// - alert fanout payloads
const tablesToTrack = ['eve_inters', 'eve_rating', 'user_rating', 'comm_rating'];
const streams = ['newEveInters', 'newEveRatings', 'newUserRatings', 'newCommRatings'];
const CONSUMER_GROUP = 'userInteractions';
const CONSUMER_NAME = `worker-${process.pid}`;
const STREAM_READ_COUNT = Number(process.env.STREAM_READ_COUNT) || 1000;
const STREAM_CLAIM_IDLE_MS = Number(process.env.STREAM_CLAIM_IDLE_MS) || 0; // 0 disables claiming
const STREAM_CLAIM_COUNT = Number(process.env.STREAM_CLAIM_COUNT) || 500;

// PROCESS USER INTERACTIONS ----------------------------------------------------
// High-throughput batch worker:
// - drains multiple streams
// - builds aggregated deltas in memory (maps/sets)
// - writes resulting SQL updates via Writer/Querer
// - updates redis/meta caches and returns alert payloads
// Steps: drain all streams, fold items into aggregation maps, apply deltas to redis meta caches (recalc metas/users), write SQL summaries, flush pipelines, ack streams, then return alert payloads.
async function processUserInteractions(con, redis) {
	try {
		const state = getStateVariables();

		const [eveUserMarkAwards, userUserMarkAwards, commUserMarkAwards] = Array.from({ length: 3 }, () => []);
		const [eveSumScoreAttendComms, userEveInterPriv, commSumScore, userSumScore, userTableChanges] = Array.from({ length: 5 }, () => new Map());
		const [newUse, newCommsEveIDsSet, eveChangeAttenSet, nonIntAttenChange] = Array.from({ length: 4 }, () => new Set());
		const interestsByEvent = new Map();
		const friendlyAffectedEveIDs = new Set();

		const toAck = new Map(); // streamName => ids[]

		const newEveCommsCounts = await redis.hgetall(REDIS_KEYS.newEveCommsCounts);
		const newEveCommsEventIDs = Object.keys(newEveCommsCounts);
		for (const [eventID, newCommsCount] of Object.entries(newEveCommsCounts)) {
			eveSumScoreAttendComms.set(eventID, [eventID, 0, 0, 0, 0, newCommsCount]);
		}
		// Clear processed comment counts to prevent double-counting on next run
		if (newEveCommsEventIDs.length) {
			await redis.hdel(REDIS_KEYS.newEveCommsCounts, ...newEveCommsEventIDs);
		}

		// STREAM DRAIN ---------------------------------------------------------
		// Steps: consume each stream via consumer group, optionally claim idle pending, and collect ids for ack only when processing succeeds.
		const streamResults = await Promise.all(
			streams.map(async (streamName, idx) => {
				try {
					const result = await Streamer({
						redis,
						streamName,
						logPrefix: `[UserInteractionsWorker:${streamName}]`,
						group: CONSUMER_GROUP,
						consumer: CONSUMER_NAME,
						count: STREAM_READ_COUNT,
						blockMs: 0,
						claimIdleMs: STREAM_CLAIM_IDLE_MS,
						claimCount: STREAM_CLAIM_COUNT,
					});

					if (result.processed > 0 && Array.isArray(result.ids)) {
						toAck.set(streamName, result);
					}

					return {
						...result,
						streamName,
						tableIndex: idx,
					};
				} catch (error) {
					logger.error('userInteractions.stream_processing_failed', { error, streamName });
					return { processed: 0, items: [], streamName, tableIndex: idx };
				}
			})
		);

		// BACKLOG WARNINGS -----------------------------------------------------
		// Steps: sample xlen and xpending, emit alerts when configured thresholds are crossed; this is diagnostics only.
		try {
			const STREAM_MAXLEN = Number(process.env.STREAM_MAXLEN) || 0;
			const STREAM_XLEN_WARN_RATIO = Number(process.env.STREAM_XLEN_WARN_RATIO) || 0.8;
			const STREAM_XPENDING_WARN = Number(process.env.STREAM_XPENDING_WARN) || 0; // 0 disables
			await Promise.all(
				streams.map(async streamName => {
					try {
						const [len, pending] = await Promise.all([redis.xlen(streamName).catch(() => 0), redis.xpending(streamName, CONSUMER_GROUP).catch(() => null)]);
						const pendCnt = Array.isArray(pending) && typeof pending[0] === 'number' ? pending[0] : 0;
						if (STREAM_XPENDING_WARN && pendCnt >= STREAM_XPENDING_WARN) logger.alert('userInteractions.stream_pending_backlog', { streamName, pending: pendCnt });
						if (STREAM_MAXLEN && len / STREAM_MAXLEN >= STREAM_XLEN_WARN_RATIO)
							logger.alert('userInteractions.stream_near_maxlen', { streamName, length: len, ratio: Number((len / STREAM_MAXLEN).toFixed(2)) });
					} catch (err) {
						logger.alert('userInteractions.stream_monitor_item_failed', { error: err?.message, streamName });
					}
				})
			);
		} catch (err) {
			logger.alert('userInteractions.stream_monitor_failed', { error: err?.message });
		}

		// Check if there's anything to process
		if (!streamResults.some(result => result.processed > 0)) {
			return { message: 'No new interactions to process' };
		}

		// Initialize table changes tracking
		tablesToTrack.forEach(table => userTableChanges.set(table, new Set()));

		// AGGREGATION ----------------------------------------------------------
		// Steps: fold each stream item into a table-specific accumulator so later phases can run in batches.
		for (const result of streamResults) {
			if (result.processed === 0) continue;

			const { items, tableIndex } = result;
			if (!items || !Array.isArray(items)) {
				logger.error('userInteractions.invalid_stream_items', { streamName: result.streamName, tableIndex });
				continue;
			}

			const table = tablesToTrack[tableIndex] || 'comments';
			const [statsSumMap, ratingAwardsMap]: any = {
				eve_inters: [eveSumScoreAttendComms],
				eve_rating: [eveSumScoreAttendComms, eveUserMarkAwards],
				user_rating: [userSumScore, userUserMarkAwards],
				comm_rating: [commSumScore, commUserMarkAwards],
			}[table];

			if (table.includes('rating')) {
				const isEventsTable = table.startsWith('eve');
				for (const item of items) {
					if (!item) continue;
					try {
						// Validate payload is an array with expected structure
						if (!Array.isArray(item) || item.length < 5) {
							logger.alert('userInteractions.rating_payload_invalid_structure', { table, item, length: item?.length });
							continue;
						}
						const [targetID, userID, mark, awards, points] = item;
						ratingAwardsMap.push([targetID, userID, mark, awards]);
						userTableChanges.get(table).add(userID),
							// eve_stats expects 6 values: [id, score, surely, maybe, interested, comments]
							((statsSumMap.get(targetID) || statsSumMap.set(targetID, isEventsTable ? [targetID, 0, 0, 0, 0, 0] : [targetID, 0]).get(targetID))[1] += points);
					} catch (error) {
						logger.error('userInteractions.rating_payload_failed', { error, table });
					}
				}
			} else if (table === 'eve_inters') {
				for (const item of items) {
					if (!item) continue;
					try {
						// Validate payload is an array with expected structure
						if (!Array.isArray(item) || item.length < 7) {
							logger.alert('userInteractions.interest_payload_invalid_structure', { item, length: item?.length });
							continue;
						}
						const [eventID, userID, surD = 0, mayD = 0, intD = 0, priv, finalInter] = item;
						userTableChanges.get(table).add(userID);
						(userEveInterPriv.get(userID) || userEveInterPriv.set(userID, new Map()).get(userID)).set(eventID, [finalInter, priv]);
						if ((Number(surD) || 0) === 0 && (Number(mayD) || 0) === 0 && (Number(intD) || 0) === 0) continue;
						if (!interestsByEvent.has(eventID)) interestsByEvent.set(eventID, { sur: 0, may: 0, int: 0 });
						const counts = interestsByEvent.get(eventID);
						(counts.sur += Number(surD) || 0), (counts.may += Number(mayD) || 0), (counts.int += Number(intD) || 0);
						const cur = statsSumMap.get(eventID) || statsSumMap.set(eventID, [eventID, 0, 0, 0, 0, 0]).get(eventID);
						(cur[2] += Number(surD) || 0), (cur[3] += Number(mayD) || 0), (cur[4] += Number(intD) || 0);
						if ((Number(surD) || 0) !== 0 || (Number(mayD) || 0) !== 0) nonIntAttenChange.add(userID);
						eveChangeAttenSet.add(eventID);
					} catch (error) {
						logger.error('userInteractions.event_interest_payload_failed', { error });
					}
				}
			}
		}

		// PROCESSOR BINDINGS ---------------------------------------------------
		// Steps: bind state+redis once so downstream helpers remain parameter-light and consistent.
		const userMetasProcessor = async params => processUserMetas({ ...params, state, redis });
		const newUsersProcessor = async params => processNewUsers({ ...params, state, userMetasProcessor });

		// EVENT META RECALC ----------------------------------------------------
		// Steps: load affected event metas from redis, apply deltas in-place, update basi counters where needed, then re-pack into city maps via processRecEveMetas.
		async function recalcEveMetas() {
			try {
				const affectEveMetaIDs = [...new Set([...eveSumScoreAttendComms.keys()])];
				if (!affectEveMetaIDs.length) return;

				const processedMetas = [];
				const metasBuffer = await redis.hmgetBuffer(REDIS_KEYS.eveMetas, ...affectEveMetaIDs);

				for (let idx = 0; idx < metasBuffer.length; idx++) {
					const strMeta = metasBuffer[idx];
					if (!strMeta) continue;

					const id = affectEveMetaIDs[idx];
					try {
						const meta = decode(strMeta);
						const basiInterUpdatePipe = redis.pipeline();
						const changes = eveSumScoreAttendComms.get(id);
						if (changes) {
							const [, eveScoreChange, surelyChange, maybeChange, interestedChange, commentsChange] = changes;
							if (interestedChange) basiInterUpdatePipe.hincrby(`${REDIS_KEYS.eveBasics}:${id}`, 'interrested', interestedChange);
							if (meta[eveTypeIdx].startsWith('a')) friendlyAffectedEveIDs.add(id);
							(meta[eveSurelyIdx] += surelyChange || 0),
								(meta[eveMaybeIdx] += maybeChange || 0),
								(meta[eveCommentsIdx] += Number(commentsChange) || 0),
								(meta[eveScoreIdx] += eveScoreChange || 0);
						}
						await basiInterUpdatePipe.exec();
						processedMetas.push([id, meta]);
					} catch (error) {
						logger.error('userInteractions.decode_event_meta_failed', { error, eventId: id });
						continue;
					}
				}

				if (processedMetas.length) processRecEveMetas({ data: processedMetas, state });
			} catch (error) {
				logger.error('userInteractions.recalc_eve_metas_failed', { error });
			}
		}

		// USER META RECALC -----------------------------------------------------
		// Steps: load user metas from redis, apply score deltas, apply attendance diffs via userEveInterPriv, and re-fanout into per-city maps.
		const missingUserIDs = new Set();
		async function recalcUserMetas() {
			try {
				const affectedUserIDs = Array.from(new Set([...userSumScore.keys(), ...nonIntAttenChange]));
				if (!affectedUserIDs.length) return;

				const metaBuffers = await redis.hmgetBuffer(REDIS_KEYS.userMetas, ...affectedUserIDs);

				const processedUsers = [];
				for (const [idx, id] of affectedUserIDs.entries()) {
					const metaBuffer = metaBuffers[idx];

					if (!metaBuffer) {
						if (nonIntAttenChange.has(id)) missingUserIDs.add(id);
						continue;
					}
					try {
						const decodedMeta = decode(metaBuffer);
						const scoreChange = userSumScore.get(id);
						if (scoreChange) decodedMeta[eveScoreIdx] += scoreChange[1] || 0;

						processedUsers.push([id, decodedMeta]);
					} catch (error) {
						logger.error('userInteractions.decode_user_meta_failed', { error, userId: id });
						continue;
					}
				}

				if (processedUsers.length) {
					await userMetasProcessor({ data: processedUsers, is: 'rec', newAttenMap: userEveInterPriv });
				}
			} catch (error) {
				logger.error('userInteractions.recalc_user_metas_failed', { error });
			}
		}

		// USER CACHE BACKFILL --------------------------------------------------
		// Steps: when a user meta is missing but attendance changed, fetch user row from SQL, rebuild a new user meta, then store into redis via newUsersProcessor.
		async function cacheMissingUsers() {
			try {
				if (missingUserIDs.size) {
					try {
						const [usersToCache] = await con.execute(`SELECT ${USER_GENERIC_KEYS} FROM users WHERE users.id IN (${getIDsString(missingUserIDs)})`); // Quote string IDs ---------------------------
						for (const user of usersToCache) {
							user.score += userSumScore.get(user.id)?.[1] || 0;
							user.eveInterPriv = Array.from(userEveInterPriv.get(user.id)?.entries() || [])
								.filter(([, interPrivArr]) => ['sur', 'may'].includes(interPrivArr?.[0]))
								.map(([eve, [inter, priv]]) => `${eve}:${inter}:${priv}`)
								.join(',');
						}
						await newUsersProcessor({ data: usersToCache });
					} catch (error) {
						logger.error('userInteractions.fetch_new_users_failed', { error, userIds: [...missingUserIDs] });
					}
				}
			} catch (error) {
				logger.error('userInteractions.cache_missing_users_failed', { error });
			}
		}

		// Execute the main processing functions and spawn pipelines
		await recalcEveMetas(), await recalcUserMetas(), await cacheMissingUsers();

		// LOCAL CACHE INVALIDATION --------------------------------------------
		// Steps: invalidate per-worker LRU caches for affected entities so next HTTP/socket reads re-fetch the updated values.
		const affectedEventIDs = [...eveSumScoreAttendComms.keys()];
		const affectedUserIDs = [...userSumScore.keys(), ...nonIntAttenChange, ...missingUserIDs];

		if (affectedEventIDs.length) affectedEventIDs.forEach(id => invalidateEventCache(id));
		if (affectedUserIDs.length) affectedUserIDs.forEach(id => invalidateUserCache(id));

		// create pipelines pipelines
		const [deletionsPipe, metasPipe, basiDetaPipe, privsPipe, attenPipe] = Array.from({ length: 5 }, () => redis.pipeline());
		loadMetaPipes(state, metasPipe, attenPipe, 'userInteractions'), loadBasicsDetailsPipe(state, basiDetaPipe);
		// Prepare SQL batch update tasks
		const tasksConfig = [
			{
				table: 'users',
				name: 'user_stats',
				arrs: [...userSumScore.values()],
				cols: ['score'],
				where: ['id'],
				colsDef: ['INT', 'INT'],
				is: 'sumUp',
			},
			{
				name: 'eve_stats',
				table: 'events',
				arrs: [...eveSumScoreAttendComms.values()],
				cols: ['score', 'surely', 'maybe', 'comments', 'interrested'],
				where: ['id'],
				colsDef: ['INT', 'INT', 'INT', 'INT', 'INT', 'INT'],
				is: 'sumUp',
			},
			{
				arrs: [...commSumScore.values()],
				name: 'comm_stats',
				table: 'comments',
				cols: ['score'],
				colsDef: ['INT', 'INT'],
				where: ['id'],
				is: 'sumUp',
			},
			// Interests rows are persisted at the endpoint; worker aggregates only
		];

		// SQL WRITE -----------------------------------------------------------
		// Steps: persist score deltas via Writer so SQL becomes the source of truth; Writer handles retries and userSummary propagation.
		await Writer({ mode: 'userInteractions', con, redis, tasksConfig, userTableChanges });

		const now = Date.now();
		const lastBestOfRecalc = await redis.get('last100BestEventsRecalc');
		if (!lastBestOfRecalc || now - Number(lastBestOfRecalc) > 60 * 1000 * 60) {
			const bestOfIDs = await redis.hkeys(REDIS_KEYS.topEvents);
			if (bestOfIDs.length > 0) {
				const bestMetas = await redis.hmgetBuffer(REDIS_KEYS.eveMetas, ...bestOfIDs);
				const validPairs = bestOfIDs.map((id, i) => [id, bestMetas[i] || null]).filter(([, meta]) => meta != null);
				if (validPairs.length > 0) {
					await redis.hset(REDIS_KEYS.topEvents, Object.fromEntries(validPairs));
					await redis.set(REDIS_KEYS.last100BestEventsRecalc, String(now));
				} else {
					logger.alert('userInteractions.best_of_missing_meta', { bestOfCount: bestOfIDs.length });
				}
			}
		}

		// Update eveLastCommentAt from newEveCommsCounts keys
		const newCommsEveIDs = Object.keys(newEveCommsCounts);
		if (newCommsEveIDs.length) metasPipe.hset('eveLastCommentAt', ...newCommsEveIDs.flatMap(eveID => [eveID, now]));
		// Update lastEveAttenChange from eveChangeAttenSet
		if (eveChangeAttenSet.size) metasPipe.hset('lastEveAttenChange', ...[...eveChangeAttenSet].flatMap(eveID => [eveID, now]));

		await Promise.all([
			deletionsPipe.exec().catch(error => {
				logger.error('userInteractions.deletions_pipe_failed', { error });
				throw error;
			}),
			metasPipe.exec().catch(error => {
				logger.error('userInteractions.metas_pipe_failed', { error });
				throw error;
			}),
			basiDetaPipe.exec().catch(error => {
				logger.error('userInteractions.basi_deta_pipe_failed', { error });
				throw error;
			}),
			privsPipe.exec().catch(error => {
				logger.error('userInteractions.privs_pipe_failed', { error });
				throw error;
			}),
			attenPipe.exec().catch(error => {
				logger.error('userInteractions.atten_pipe_failed', { error });
				throw error;
			}),
		]);
		// ACK AFTER COMMIT -----------------------------------------------------
		// Steps: ack stream ids only after redis+sql writes succeed so the stream remains the durability boundary.
		await Promise.all(
			[...toAck.entries()].map(async ([streamName, { ack, ids }]) => {
				try {
					await ack(ids);
				} catch (error) {
					logger.error('userInteractions.stream_ack_failed', { error, streamName, attempt: 1 });
					try {
						await new Promise(r => setTimeout(r, 200));
						await ack(ids);
					} catch (errorRetry) {
						logger.error('userInteractions.stream_ack_retry_failed', { error: errorRetry, streamName, attempt: 2 });
					}
				}
			})
		);

		const interactionsAlerts = [];
		const userRatingsMap = new Map();

		// EVENT INTERREST ALERTS ---------------------------------------------------------
		if (interestsByEvent.size) {
			logger.info('userInteractions.interest_alerts', {
				eventIds: [...interestsByEvent.keys()],
				counts: [...interestsByEvent.entries()].map(([id, c]) => ({ id, type: typeof id, counts: c })),
			});
			for (const [eventID, counts] of interestsByEvent.entries()) {
				interactionsAlerts.push({
					what: 'interest',
					target: eventID,
					data: { counts },
				});
			}
		}

		// COMM RATING ALERTS ------------------------------------------------------------
		if (commSumScore.size) {
			for (const [commID, data] of commSumScore.entries()) {
				interactionsAlerts.push({
					what: 'comm_rating',
					target: commID,
					data: { counts: data[1] },
				});
			}
		}

		// EVENT RATING ALERTS ------------------------------------------------------------
		if (eveSumScoreAttendComms.size) {
			logger.info('userInteractions.eve_rating_alerts', {
				eventIds: [...eveSumScoreAttendComms.keys()],
				data: [...eveSumScoreAttendComms.entries()].map(([id, d]) => ({ id, type: typeof id, points: d?.[1] })),
			});
			for (const [eventID, data] of eveSumScoreAttendComms.entries()) {
				const points = Number(data?.[1]) || 0;
				if (!points) continue; // do not emit rating alerts when only interests/comments changed
				interactionsAlerts.push({
					what: 'eve_rating',
					target: eventID,
					data: { counts: points },
				});
			}
		}

		// USER RATING ALERTS -------------------------------------------------------------
		if (userSumScore.size) {
			for (const [userID, data] of userSumScore.entries()) {
				if (!userRatingsMap.has(userID)) userRatingsMap.set(userID, []);
				userRatingsMap.get(userID).push({
					what: 'user_rating',
					target: userID,
					data: { counts: data[1] },
				});
			}
		}

		// Clear memory
		clearState(state);
		[eveUserMarkAwards, userUserMarkAwards, commUserMarkAwards].forEach(arr => (arr.length = 0));
		[eveSumScoreAttendComms, userEveInterPriv, commSumScore, userSumScore, userTableChanges].forEach(map => map.clear());
		[newUse, newCommsEveIDsSet, eveChangeAttenSet].forEach(set => set.clear());
		interestsByEvent.clear();

		return { interactionsAlerts, userRatingsMap };
	} catch (error) {
		logger.error('userInteractions.unhandled', { error });
		Catcher({ origin: 'userInteractions', error });
		return {
			taskName: 'userInteractions',
			success: false,
			error: error.message,
		};
	}
}

export default processUserInteractions;
