// DELETION QUERIES =============================================================
import { getIDsString } from '../../../shared/utilities.ts';
import { Querer } from '../../systems/systems.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('Task:DailyRecalc:DeletionQueries');

// BUILD RECALC QUERIES ---------------------------
// Steps: translate sets of ids into minimal SQL batches; keep each sub-task isolated so failures are attributable and retries can be scoped.
export function buildRecalcQueries({ pastEveIDs, remEventsIDs, froUse, delUse, unfUse, delEve }) {
	const recalcQs: any = {},
		ids = set => getIDsString(set);
	if (pastEveIDs.length) recalcQs.pastEve = [`UPDATE events SET flag = 'pas' WHERE id IN (${pastEveIDs.map(id => `'${id}'`).join(',')})`];

	if (remEventsIDs.size)
		recalcQs.remEventsIDs = [
			`INSERT INTO rem_comments SELECT * FROM comments WHERE event IN (${ids(remEventsIDs)})`,
			`DELETE comm_rating FROM comm_rating JOIN comments ON comments.id = comm_rating.comment WHERE comments.event IN (${ids(remEventsIDs)})`,
			`DELETE FROM eve_rating WHERE event IN (${ids(remEventsIDs)})`,
			`DELETE FROM eve_invites WHERE event IN (${ids(remEventsIDs)})`,
			...(delEve.size ? [`DELETE FROM eve_inters WHERE event IN (${ids(delEve)})`] : []),
			`UPDATE rem_events SET flag = 'don' WHERE id IN (${ids(remEventsIDs)})`,
		];

	if (froUse.size) recalcQs.froUse = [`UPDATE eve_inters SET inter = 'int' WHERE user in (${ids(froUse)})`, `UPDATE fro_users SET flag = 'don' WHERE id IN (${ids(froUse)})`];

	if (delUse.size)
		recalcQs.delUse = [
			`DELETE FROM rjwt_tokens WHERE user IN (${ids(delUse)})`,
			`DELETE FROM logins WHERE user IN (${ids(delUse)})`,
			`DELETE FROM user_links WHERE user IN (${ids(delUse)}) OR user2 IN (${ids(delUse)})`,
			`DELETE FROM user_blocks WHERE user IN (${ids(delUse)}) OR user2 IN (${ids(delUse)})`,
			`DELETE FROM user_rating WHERE user IN (${ids(delUse)}) OR user2 IN (${ids(delUse)})`,
			`DELETE FROM eve_invites WHERE user2 IN (${ids(delUse)}) OR user IN (${ids(delUse)})`,
			`DELETE FROM eve_inters WHERE user IN (${ids(delUse)})`,
			`DELETE FROM comm_rating WHERE user IN (${ids(delUse)})`,
			`DELETE FROM user_alerts WHERE user IN (${ids(delUse)})`,
		];

	if (unfUse.size)
		recalcQs.unfUse = [
			`INSERT INTO users SELECT * FROM fro_users WHERE id IN (${ids(unfUse)})`,
			`DELETE FROM fro_users WHERE id IN (${ids(unfUse)})`,
			`UPDATE users SET flag = 'ok' WHERE id IN (${ids(unfUse)})`,
		];
	return recalcQs;
}

// EXECUTE RECALC QUERIES ---------------------------
// Steps: execute each query batch atomically per task key; fail fast so we don’t partially apply deletion cascades.
export async function executeRecalcQueries({ con, recalcQs }) {
	for (const [task, queries] of Object.entries(recalcQs))
		try {
			await Querer({ con, queries, task, mode: 'atomic_seq' });
		} catch (error) {
			logger.error('dailyRecalc.batch_query_failed', { error, task, queries });
			throw error;
		}
}

// CLEANUP DELETED USERS REDIS ---------------------------
// Steps: record deletion timestamps, purge refresh tokens by user prefix, and remove per-(user,chat) role keys so authorization cache can’t reference deleted users.
export async function cleanupDeletedUsersRedis({ con, redis, delUse, now }) {
	if (!delUse.size) return;
	const pipe = redis.pipeline(),
		ids = getIDsString(delUse);
	for (const u of delUse) {
		pipe.hset('remUse', u, now);
		pipe.eval(
			`local keys=redis.call('HKEYS',KEYS[1]) local d=0 for _,k in ipairs(keys) do if string.sub(k,1,#ARGV[1])==ARGV[1] then redis.call('HDEL',KEYS[1],k) d=d+1 end end return d`,
			1,
			REDIS_KEYS.refreshTokens,
			`${u}_`
		);
	}
	const chats = (await con.execute(`SELECT chat FROM chat_members WHERE id IN (${ids})`))[0],
		keys = chats.flatMap(({ chat }) => [...delUse].map(u => `${u}_${chat}`));
	if (keys.length) pipe.hdel(REDIS_KEYS.userChatRoles, ...keys);
	await pipe.exec();
}

// CLEANUP REMOVED EVENTS REDIS ---------------------------
// Steps: delete cached comment previews for removed events, then drop per-event comment counters so UI doesn’t surface stale numbers.
export async function cleanupRemovedEventsRedis({ con, redis, remEventsIDs }) {
	if (!remEventsIDs.size) return;
	const rows = (await con.execute(`SELECT id FROM comments WHERE event IN (${getIDsString(remEventsIDs)})`))[0];
	const pipe = redis.pipeline();
	if (rows.length) pipe.hdel('commentAuthorContent', ...rows.map(r => r.id));
	pipe.hdel('newEveCommsCounts', ...remEventsIDs).exec();
}
