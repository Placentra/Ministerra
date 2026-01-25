
import { Sql } from '../systems.ts';
import dailyRecalc from '../../tasks/dailyRecalc/index.ts';
import { encode } from 'cbor-x';
import { getStateVariables, processUserMetas, processNewUsers, processNewEvents, processNewEveMetas, loadMetaPipes, loadBasicsDetailsPipe, clearState } from '../../utilities/contentHelpers.ts';
import { getLogger } from './loggers.ts';
import { REDIS_KEYS, USER_GENERIC_KEYS, EVENT_COLUMNS } from '../../../shared/constants.ts';
import { toMySqlDateFormat } from '../../../shared/utilities.ts';
import { reportSubsystemReady } from '../../cluster/readiness.ts';

const logger = getLogger('Cacher');
const getRowsAfter = toMySqlDateFormat(new Date(new Date().setMonth(new Date().getMonth() - 3)));

// MAP-OF-ARRAYS PUSH -----------------------------------------------------------
// Steps: keep hot-path map building dense while preserving type intent at call sites.
const addToMap = (map: Map<any, any[]>, key: any, value: any): number => (map.get(key) || (map.set(key, []), map.get(key)!)).push(value);

interface StreamAndProcessProps {
	con: any;
	sql: string;
	params?: any[];
	batchSize?: number;
	processor: (_: any[]) => Promise<void>;
}

// STREAM AND PROCESS -----------------------------------------------------------
// Steps: stream SQL rows and process in batches to cap memory and preserve backpressure.
async function streamAndProcess({ con, sql, params = [], batchSize = 1000, processor }: StreamAndProcessProps): Promise<void> {
	const promisePool: any = con.getPrimaryPool ? con.getPrimaryPool() : con;
	const rawPool: any = promisePool.pool || promisePool;
	const actualPool: any = rawPool.connection || rawPool.pool || rawPool;
	const stream: any = actualPool.query(sql, params).stream();

	let batch: any[] = [];
	for await (const row of stream) {
		batch.push(row);
		if (batch.length >= batchSize) {
			await processor(batch);
			batch = [];
		}
	}
	if (batch.length) await processor(batch);
}

// CACHER SYSTEM ---------------------------------------------------------------
// Manages system startup state reconstruction. Rebuilds Redis caches from SQL (Cities, Events, Users, Tokens, Social Graphs).
// Performs daily recalculations if needed.

export async function Cacher(redis: any): Promise<void> {
	let con: any;
	try {
		// CONNECTION ACQUIRE ----------------------------------------------------
		// Cacher is run during bootstrap; it must release the connection even on failures.
		con = await Sql.getConnection();
		const [{ lastDailyRecalc, lastServerStart } = {}]: [any, any] = (await con.execute('SELECT last_server_start, last_daily_recalc FROM miscellaneous LIMIT 1'))[0];
		await con.execute(`SET time_zone = '+00:00'`);

		// DAILY RECALC GATE ---
		// Steps: if daily job is stale, run it before any rebuild so derived caches aren't built from outdated base tables.
		const day: number = 864e5;
		let dailyRecalcEndTime: number | null = null;
		if (!lastDailyRecalc || Date.now() - new Date(lastDailyRecalc).getTime() > day) {
			await dailyRecalc(con, redis);
			dailyRecalcEndTime = Date.now();
			await con.execute(`UPDATE miscellaneous SET last_daily_recalc = NOW() WHERE id = 0`);
			reportSubsystemReady('DAILY_RECALC');
		}

		// REBUILD SKIP GATE ---
		// Steps: when server already started recently, avoid a full flush+rebuild to reduce boot latency; this is an ops optimization.
		const serverStartedExists: number = await redis.exists(REDIS_KEYS.serverStarted);
		const timeSinceLastStart: number = lastServerStart ? Date.now() - new Date(lastServerStart).getTime() : Infinity;

		// INFO commented out for testing purposes
		// if (serverStartedExists && lastServerStart && timeSinceLastStart <= 3 * day) {
		// 	if (dailyRecalcEndTime) await redis.hset(REDIS_KEYS.tasksFinishedAt, 'dailyRecalc', dailyRecalcEndTime.toString());
		// 	logger.info(`Cache rebuild skipped (last start ${Math.round(timeSinceLastStart / 1000)}s ago)`);
		// 	reportSubsystemReady('CACHE_REBUILD');
		// 	return;
		// }
		logger.info(`Cache rebuild required (serverStartedExists=${serverStartedExists}, timeSinceLastStart=${Math.round(timeSinceLastStart / 1000)}s)`);

		// FULL REBUILD ----------------------------------------------------------
		// Steps: clear relevant cache keys (NOT flushall to avoid wiping shared Redis data in multi-node), materialize active user set, then rebuild independent cache buckets in parallel.
		logger.info('Starting full cache rebuild...');
		const state: any = getStateVariables();

		// TARGETED KEY DELETION ---
		// Steps: delete only keys that will be rebuilt, preserving any shared/external data.
		// Simple keys deleted directly, prefixed keys via SCAN to avoid blocking on large datasets.
		const simpleKeys = [
			REDIS_KEYS.citiesData,
			REDIS_KEYS.eveCityIDs,
			REDIS_KEYS.topEvents,
			REDIS_KEYS.eveTitleOwner,
			REDIS_KEYS.friendlyEveScoredUserIDs,
			REDIS_KEYS.eveMetas,
			REDIS_KEYS.eveBasics,
			REDIS_KEYS.eveDetails,
			REDIS_KEYS.userMetas,
			REDIS_KEYS.userBasics,
			REDIS_KEYS.refreshTokens,
			REDIS_KEYS.userChatRoles,
			REDIS_KEYS.lastMembChangeAt,
			REDIS_KEYS.serverStarted,
			REDIS_KEYS.lastNewCommAt,
			REDIS_KEYS.eveLastAttendChangeAt,
			REDIS_KEYS.userNameImage,
		];
		await redis.del(...simpleKeys);

		// PREFIX PATTERNS ---
		// Steps: use SCAN to find and delete prefixed keys without blocking Redis.
		const prefixPatterns = ['blocks:*', 'links:*', 'trusts:*', 'invites:*', 'userSummary:*', 'userSetsLastChange:*', 'chatMembers:*'];
		for (const pattern of prefixPatterns) {
			let cursor = '0';
			do {
				const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
				cursor = nextCursor;
				if (keys.length) await redis.del(...keys);
			} while (cursor !== '0');
		}

		// RESTORE TASKS STATE ---
		// Steps: preserve dailyRecalc completion time so task threads don't re-run unnecessarily.
		if (dailyRecalcEndTime) await redis.hset(REDIS_KEYS.tasksFinishedAt, 'dailyRecalc', dailyRecalcEndTime.toString());

		// ACTIVE USER MATERIALIZATION ---------------------------------------
		// The rebuild uses a temp table so multiple joins can share the same active user set.
		await con.execute(`CREATE TEMPORARY TABLE active_users (user BIGINT UNSIGNED PRIMARY KEY) AS SELECT user FROM logins WHERE inactive = FALSE`);
		const activeUsersSet: Set<string> = new Set((await con.execute(`SELECT user FROM active_users`))[0].map((r: any) => String(r.user)));

		// PARALLEL REBUILD PHASE ---------------------------------------------
		// Steps: rebuild independent buckets concurrently to reduce total boot time while keeping each bucket internally ordered.
		await Promise.all([
			// 1. CITIES DATA ---
			(async (): Promise<void> => {
				const [cities]: [any[], any] = await Sql.execute(`SELECT id, city, hashID, ST_Y(coords) as lat, ST_X(coords) as lng FROM cities`);
				if (cities.length)
					await Promise.all([
						redis.hset(REDIS_KEYS.citiesData, ...cities.flatMap(c => [c.id, encode({ city: c.city, hashID: c.hashID, lat: c.lat, lng: c.lng })])),
						redis.hset(REDIS_KEYS.cityIDs, ...cities.flatMap(c => [c.hashID, c.id])),
					]);
				logger.info(`Cached ${cities.length} cities`);
			})(),

			// 2. EVENTS & USERS CONTENT ---
			// Steps: stream events/users, pack metas + payloads, flush to Redis incrementally, and clear state maps between batches to cap RAM.
			(async (): Promise<void> => {
				const EVENTS_BATCH_SIZE: number = 5000;
				let eventsCount: number = 0;

				await streamAndProcess({
					con: Sql,
					sql: `SELECT ${EVENT_COLUMNS} FROM events e INNER JOIN cities c ON e.cityID = c.id WHERE e.flag NOT IN ('pas', 'del', 'new') ORDER BY 3 * e.surely + e.maybe + 0.2 * e.score DESC`,
					batchSize: EVENTS_BATCH_SIZE,
					processor: async (batch: any[]) => {
						eventsCount += batch.length;
						await processNewEvents({
							data: batch,
							state,
							newEventsProcessor: async ({ data }: { data: any }) => {
								// BATCH FLUSH ---
								// Steps: flush per-batch so state maps don’t balloon; keep only cross-batch essentials via clearState keep-list.
								processNewEveMetas({ data, state });
								const pipe: any = redis.pipeline();
								loadMetaPipes(state, pipe, pipe, 'streaming'); // Partial flush
								loadBasicsDetailsPipe(state, pipe); // Partial flush of basics/details
								await pipe.exec();
								// STATE TRIM ---
								// Steps: drop per-batch maps immediately; keep cross-batch indexes that are needed for user attendance partitioning.
								clearState(state, ['eveCityIDs', 'best100EveIDs', 'best100EveMetas']);
							},
						});
					},
				});

				// USERS STREAMING ----------------------------------------------------
				// Similar streaming approach for users to avoid OOM on large user bases.
				const USERS_BATCH_SIZE: number = 5000;
				let usersCount: number = 0;

				await streamAndProcess({
					con: Sql,
					sql: `SELECT ${USER_GENERIC_KEYS.map(col => `u.${col}`).join(
						', '
					)}, GROUP_CONCAT(DISTINCT CONCAT(ei.event, ':' , ei.inter, ':' , ei.priv)) AS eveInterPriv FROM users u INNER JOIN eve_inters ei ON u.id = ei.user INNER JOIN events e ON ei.event = e.id  AND e.flag NOT IN ('pas', 'del') AND e.type LIKE 'a%' AND ei.inter IN ('sur', 'may') GROUP BY u.id`,
					batchSize: USERS_BATCH_SIZE,
					processor: async (batch: any[]) => {
						usersCount += batch.length;
						await processNewUsers({
							data: batch,
							state,
							userMetasProcessor: async ({ data, is }: { data: any; is: any }) => {
								const pipe: any = redis.pipeline();
								// USER META BUILD ---
								// Steps: rebuild attendance, per-city fanout, and scored sets, then flush same as events.
								await processUserMetas({ data, is, newAttenMap: null, privUse: null, state, pipe, redis });
								loadMetaPipes(state, pipe, pipe, 'streaming');
								loadBasicsDetailsPipe(state, pipe);
								await pipe.exec();
								clearState(state, ['eveCityIDs', 'best100EveIDs', 'best100EveMetas']);
							},
						});
					},
				});
				logger.info(`Streamed and cached ${eventsCount} events and ${usersCount} users.`);
			})(),

			// 3. REFRESH TOKENS ---
			// Restores refresh tokens so sessions remain valid after restart.
			// Using stream to handle potentially millions of tokens.
			(async (): Promise<void> => {
				const pipe: any = redis.pipeline();
				let count: number = 0;
				await streamAndProcess({
					con: Sql,
					sql: `SELECT user, device, token, print FROM rjwt_tokens WHERE created > NOW() - INTERVAL 3 DAY`,
					batchSize: 5000,
					processor: async (batch: any[]) => {
						if (!batch.length) return;
						const args: any[] = batch.flatMap(t => [`${t.user}_${t.device}`, `${t.token}:${t.print}`]);
						pipe.hset('refreshTokens', ...args);
						await pipe.exec();
						count += batch.length;
					},
				});
				if (count > 0) logger.info(`Restored ${count} refresh tokens`);
			})(),

			// 4-8. CONNECTION-DEPENDENT REBUILDS (Sequential on single connection to support Temporary Tables) ---
			(async (): Promise<void> => {
				// 4. USER SETS (LINKS, BLOCKS, TRUSTS) ---
				const getQ = (t: string): string =>
					`SELECT t.user, t.user2${t === 'user_links' ? ', t.link, t.who' : ''} FROM ${t} t JOIN active_users au ON t.user = au.user OR t.user2 = au.user ${
						t === 'user_links' ? 'WHERE t.link IN ("ok", "tru")' : ''
					}`;
				const maps: { links: Map<string, any[]>; trusts: Map<string, any[]> } = { links: new Map(), trusts: new Map() };
				const pipe: any = redis.pipeline();
				let linksCount: number = 0,
					trustsCount: number = 0,
					blocksCount: number = 0;

				await streamAndProcess({
					con,
					sql: getQ('user_links'),
					batchSize: 5000,
					processor: async (batch: any[]) => {
						maps.links.clear();
						maps.trusts.clear();
						for (const { user, user2, who, link } of batch) {
							if (link === 'tru') {
								trustsCount++;
								if (who == 3) [user, user2].forEach(u => activeUsersSet.has(u) && addToMap(maps.trusts, u, u === user ? user2 : user));
								else {
									const s: string[] = [user, user2].sort();
									addToMap(maps.trusts, s[who - 1], s[2 - who]);
								}
							}
							linksCount++;
							[user, user2].forEach(u => activeUsersSet.has(u) && addToMap(maps.links, u, u === user ? user2 : user));
						}
						for (const [k, v] of maps.links) if (v?.length) pipe.sadd(`${REDIS_KEYS.links}:${k}`, ...v);
						for (const [k, v] of maps.trusts) if (v?.length) pipe.sadd(`${REDIS_KEYS.trusts}:${k}`, ...v);
						await pipe.exec();
					},
				});

				const blocksMap: Map<string, any[]> = new Map();
				await streamAndProcess({
					con,
					sql: getQ('user_blocks'),
					batchSize: 5000,
					processor: async (batch: any[]) => {
						blocksMap.clear();
						for (const { user, user2 } of batch) {
							blocksCount++;
							[user, user2].forEach(u => activeUsersSet.has(u) && addToMap(blocksMap, u, u === user ? user2 : user));
						}
						for (const [k, v] of blocksMap) if (v?.length) pipe.sadd(`${REDIS_KEYS.blocks}:${k}`, ...v);
						await pipe.exec();
					},
				});
				logger.info(`Cached ${linksCount} links, ${trustsCount} trusts, ${blocksCount} blocks`);

				// 5. INVITES ---
				const iMap: Map<string, any[]> = new Map();
				let invitesCount: number = 0;
				await streamAndProcess({
					con,
					sql: `SELECT ei.user2 AS user, ei.event FROM eve_invites ei JOIN active_users au ON ei.user2 = au.user WHERE ei.flag IN ('ok','acc')`,
					batchSize: 5000,
					processor: async (batch: any[]) => {
						iMap.clear();
						invitesCount += batch.length;
						batch.forEach(({ user, event }) => addToMap(iMap, user, event));
						for (const [u, evs] of iMap) pipe.sadd(`${REDIS_KEYS.invites}:${u}`, ...evs);
						await pipe.exec();
					},
				});
				logger.info(`Cached ${invitesCount} event invites`);

				// 6. CHAT MEMBERS & ROLES ---
				const memMap: Map<string, any[]> = new Map();
				const roleMap: Map<string, string> = new Map();
				let membersCount: number = 0,
					chatsCount: Set<string | number> = new Set();
				await streamAndProcess({
					con,
					sql: `SELECT cm.chat, cm.punish, cm.id, cm.role, cm.archived FROM chat_members cm LEFT JOIN active_users au ON cm.id = au.user LEFT JOIN chats c ON cm.chat = c.id WHERE cm.flag = 'ok' AND c.dead = 0 AND (cm.punish != 'ban' OR cm.until < NOW())`,
					batchSize: 5000,
					processor: async (batch: any[]) => {
						memMap.clear();
						roleMap.clear();
						for (const { chat, id, role, punish, archived } of batch) {
							membersCount++;
							chatsCount.add(chat);
							if (!archived) addToMap(memMap, chat, id);
							roleMap.set(`${id}_${chat}`, punish === 'gag' ? 'gagged' : role);
						}
						for (const [c, ids] of memMap) pipe.sadd(`${REDIS_KEYS.chatMembers}:${c}`, ...ids);
						if (roleMap.size) pipe.hset(REDIS_KEYS.userChatRoles, ...Array.from(roleMap.entries()).flatMap(x => x));
						await pipe.exec();
					},
				});
				logger.info(`Cached ${membersCount} chat memberships across ${chatsCount.size} chats`);

				// 7. USER NAMES & IMAGES ---
				const [users]: [any[], any] = await con.execute(`SELECT u.id, u.first, u.last, u.imgVers FROM users u JOIN active_users au ON u.id = au.user WHERE u.flag NOT IN ('del', 'fro')`);
				if (users.length) await redis.hset(REDIS_KEYS.userNameImage, ...users.flatMap(u => [u.id, encode([u.first || '', u.last || '', u.imgVers || ''])]));
				logger.info(`Cached ${users.length} user names and images`);

				// 8. USER SUMMARY & ALERTS ---
				const summaryPipe: any = redis.pipeline();
				const runSummary = async (tables: string[], prevFailed: number = Infinity): Promise<void> => {
					const failed: string[] = [];
					for (const tbl of tables) {
						try {
							const biirectTbl = tbl === 'user_links'
							const [rows]: [any[], any] = await con.execute(
								`SELECT t.user${biirectTbl ? ', t.user2' : ''}, MAX(t.changed) as c FROM ${tbl} t JOIN active_users au ON t.user = au.user ${
									biirectTbl ? 'OR t.user2 = au.user' : ''
								} GROUP BY t.user${biirectTbl ? ', t.user2' : ''}`
							);
							const changes: Map<string, any[]> = new Map(),
								add = (u: any, c: any): number => (changes.get(u) || (changes.set(u, []), changes.get(u)!)).push(tbl, new Date(c).getTime());
							for (const r of rows) biirectTbl ? [r.user, r.user2].forEach(u => add(u, r.c)) : add(r.user, r.c);
							for (const [u, vals] of changes) summaryPipe.hset(`${REDIS_KEYS.userSummary}:${u}`, ...vals);
						} catch (e) {
							logger.error(`cacher.tbl_fail: ${tbl}`, { error: e, tbl });
							failed.push(tbl);
						}
					}
					if (failed.length && failed.length < prevFailed) await runSummary(failed, failed.length);
				};
				await runSummary(['user_links', 'eve_rating', 'user_rating', 'comm_rating', 'eve_inters']);
				if (activeUsersSet.size) {
					try {
						const [mis]: [any[], any] = await con.execute(
							`SELECT DISTINCT cm.id AS u FROM chat_members cm JOIN chats c ON c.id = cm.chat JOIN last_seen ls ON ls.user = cm.id AND cm.seen = ls.mess WHERE cm.flag = 'ok' AND c.last_mess > ls.mess AND cm.id IN (SELECT user FROM active_users)`
						);
						const [alt]: [any[], any] = await con.execute(
							`SELECT DISTINCT ua.user AS u FROM user_alerts ua JOIN last_seen ls ON ua.user = ls.user WHERE ua.id > ls.alert AND ua.user IN (SELECT user FROM active_users)`
						);
						const [arc]: [any[], any] = await con.execute(
							`SELECT DISTINCT cm.id AS u FROM chat_members cm WHERE cm.archived = TRUE AND cm.miss_arc = 1 AND cm.id IN (SELECT user FROM active_users)`
						);
						const mSet: Set<string> = new Set(mis.map(r => String(r.u))),
							aSet: Set<string> = new Set(alt.map(r => String(r.u))),
							arSet: Set<string> = new Set(arc.map(r => String(r.u)));
						for (const u of activeUsersSet)
							summaryPipe.hset(`${REDIS_KEYS.userSummary}:${u}`, 'chats', mSet.has(u) ? 2 : 0, 'alerts', aSet.has(u) ? 2 : 0, 'archive', arSet.has(u) ? 1 : 0);
					} catch (e) {
						logger.error('cacher.alerts_fail', { e });
					}
				}
				await summaryPipe.exec();
				logger.info(`Cached user summaries and alerts for ${activeUsersSet.size} active users`);
			})(),

			// 9. NON-TEMP METADATA UPDATES ---
			(async (): Promise<void> => {
				const [chatChanges]: [any[], any] = await Sql.execute(`SELECT id, changed FROM chats WHERE type != 'private' AND dead = 0`);
				if (chatChanges.length) await redis.hset(REDIS_KEYS.lastMembChangeAt, ...chatChanges.flatMap(x => [x.id, new Date(x.changed).getTime()]));

				const [eveUserChanges]: [any[], any] = await Sql.execute(
					`SELECT ei.event, MAX(ei.changed) as c FROM eve_inters ei JOIN events e ON ei.event = e.id AND e.type LIKE 'a%' AND e.flag NOT IN ('del', 'pas', 'new') WHERE ei.changed > NOW() - INTERVAL 1 MONTH GROUP BY ei.event`
				);
				if (eveUserChanges.length) await redis.hset(REDIS_KEYS.eveLastAttendChangeAt, ...eveUserChanges.flatMap(x => [x.event, new Date(x.c).getTime()]));

				const [events]: [any[], any] = await Sql.execute(`SELECT id, title, owner FROM events WHERE flag != 'del'`);
				if (events.length) await redis.hset(REDIS_KEYS.eveTitleOwner, ...events.flatMap(e => [e.id, encode([e.title?.slice(0, 50) || '', e.owner || ''])]));
				logger.info(`Cached metadata: ${chatChanges.length} chat changes, ${eveUserChanges.length} event changes, ${events.length} event titles`);
			})(),

			// 10. LAST COMMENT TIMESTAMPS ---
			(async (): Promise<void> => {
				const [changes]: [any[], any] = await Sql.execute(
					`SELECT c.event, c.created FROM comments c JOIN events e ON c.event = e.id WHERE c.id IN (SELECT MAX(c2.id) FROM comments c2 JOIN events e2 ON c2.event = e2.id WHERE e2.flag != 'del' AND e2.starts > ? GROUP BY c2.event)`,
					[getRowsAfter]
				);
				if (changes.length) await redis.hset(REDIS_KEYS.lastNewCommAt, ...changes.flatMap(c => [c.event, c.created]));
				logger.info(`Cached ${changes.length} last-comment timestamps`);
			})(),
		]);

		// FINALIZATION ---
		// Steps: flush remaining leftovers, mark last_server_start, mark serverStarted, and seed monotonic counters for writers.
		const [metasPipe, basiDetaPipe, attenPipe]: any[] = Array.from({ length: 3 }, () => redis.pipeline());

		loadMetaPipes(state, metasPipe, attenPipe, 'serverStart');
		loadBasicsDetailsPipe(state, basiDetaPipe);
		await Promise.all([metasPipe.exec(), basiDetaPipe.exec(), attenPipe.exec(), clearState(state), redis.set(REDIS_KEYS.serverStarted, Date.now())]);

		// SEQUENTIAL CONNECTION CLEANUP ---
		// Steps: must be sequential as they share the single 'con' instance; concurrently executing on one connection throws.
		await con.execute(`UPDATE miscellaneous SET last_server_start = NOW() WHERE id = 0`);
		await con.execute(`DROP TEMPORARY TABLE IF EXISTS active_users`);

		reportSubsystemReady('CACHE_REBUILD');
	} catch (error) {
		logger.error('cacher.unhandled', { error });
	} finally {
		// CONNECTION RELEASE ----------------------------------------------------
		con?.release();
	}
}
