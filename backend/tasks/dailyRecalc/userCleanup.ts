// USER CLEANUP =================================================================
import { getIDsString } from '../../../shared/utilities';
import { REDIS_KEYS } from '../../../shared/constants';
import { getLogger } from '../../systems/handlers/logging/index';

const logger = getLogger('Task:DailyRecalc:UserCleanup');

// REMOVE INACTIVE USER SETS FROM REDIS ---------------------------
// Steps: delete per-user relationship and summary keys for inactive users so redis does not accumulate stale sets.
export async function removeInactiveUserSetsFromRedis({ redis, inaUse }) {
	if (!inaUse?.size) return;
	const keys = [...inaUse].flatMap(id => [REDIS_KEYS.links, REDIS_KEYS.blocks, REDIS_KEYS.invites, REDIS_KEYS.userSummary].map(s => `${s}:${id}`));
	if (keys.length) await redis.del(keys);
}

// UPDATE REDIS USER SETS ---------------------------
// Steps: for users that are being deleted/cleaned, remove their direct keys, remove them from other users' sets, remove their scored-user entries from event zsets,
// and clean invites for removed events; missing relationship sets are backfilled from SQL when redis is cold.
export async function updateRedisUserSets({ con, redis, allDelUserIDs, delUse, remEventsIDs, REDIS_USERSET_BATCH_LIMIT: batch }) {
	if (!allDelUserIDs.size) return;
	const allIds = [...allDelUserIDs],
		limitedIds = batch > 0 ? allIds.slice(0, batch) : allIds;
	if (!limitedIds.length) return;
	if (batch > 0 && allIds.length > limitedIds.length) logger.info('dailyRecalc.redis_user_sets_batch_limited', { processed: limitedIds.length, total: allIds.length });

	const targetIds = new Set(limitedIds),
		delUseBatch = limitedIds.filter(id => delUse.has(id));
	const getSets = (ids, type) => (ids.length ? redis.pipeline(ids.map(id => ['smembers', `${type}:${id}`])).exec() : Promise.resolve([]));
	const [linkSets, blockSets] = await Promise.all([getSets(delUseBatch, REDIS_KEYS.links), getSets(delUseBatch, REDIS_KEYS.blocks)]);

	const maps = { links: new Map(), blocks: new Map() },
		missing = { links: new Set(), blocks: new Set() };
	const processSets = (sets, type) => sets.forEach(([, m], i) => (m?.length ? maps[type].set(delUseBatch[i], m) : missing[type].add(delUseBatch[i])));
	processSets(linkSets, 'links');
	processSets(blockSets, 'blocks');

	// SQL BACKFILL --------------------------------------------------------------
	// Steps: when redis does not have relationship sets for a deleted user, query edges from SQL so we can still remove reverse links.
	const queries = [];
	if (missing.links.size) queries.push(con.execute(`SELECT user, user2 FROM user_links WHERE user IN (${getIDsString(missing.links)}) OR user2 IN (${getIDsString(missing.links)})`));
	if (missing.blocks.size) queries.push(con.execute(`SELECT user, user2 FROM user_blocks WHERE user IN (${getIDsString(missing.blocks)}) OR user2 IN (${getIDsString(missing.blocks)})`));
	if (remEventsIDs.size) queries.push(con.execute(`SELECT user2, event FROM eve_invites WHERE event IN (${getIDsString(remEventsIDs)})`));

	const results = queries.length
		? await Promise.all(
				queries.map(p =>
					p.catch(error => {
						logger.error('dailyRecalc.redis_backfill_query_failed', { error });
						throw error;
					})
				)
		  )
		: [];
	let resIdx = 0,
		linkRows = missing.links.size ? results[resIdx++][0] : [],
		blockRows = missing.blocks.size ? results[resIdx++][0] : [],
		invitesRows = remEventsIDs.size ? results[resIdx++][0] : [];

	const [interRows] = delUseBatch.length ? await con.execute(`SELECT user, event FROM eve_inters WHERE user IN (${getIDsString(delUseBatch)}) AND inter IN ('sur', 'may')`) : [[]];
	const userEventMap = interRows.reduce((acc, { user, event }) => acc.set(user, (acc.get(user) || new Set()).add(event)), new Map());

	// REDIS CLEANUP PIPELINE -----------------------------------------------------
	// Steps: delete direct keys, remove from reverse sets, and remove event-score zset members via Lua scan+zrem (member strings can be `uid` or `uid_priv`).
	const pipe = redis.pipeline(),
		keys = [REDIS_KEYS.userBasics, REDIS_KEYS.userSummary, REDIS_KEYS.userActiveChats, REDIS_KEYS.tempProfile, REDIS_KEYS.links, REDIS_KEYS.blocks, REDIS_KEYS.invites, REDIS_KEYS.trusts],
		hKeys = [REDIS_KEYS.userMetas, REDIS_KEYS.userNameImage, REDIS_KEYS.userChatRoles];
	for (const uid of targetIds) {
		keys.forEach(k => pipe.del(`${k}:${uid}`));
		hKeys.forEach(k => pipe.hdel(k, uid));
		(maps.links.get(uid) || []).forEach(oid => !targetIds.has(oid) && pipe.srem(`${REDIS_KEYS.links}:${oid}`, uid));
		(maps.blocks.get(uid) || []).forEach(oid => !targetIds.has(oid) && pipe.srem(`${REDIS_KEYS.blocks}:${oid}`, uid));
		(userEventMap.get(uid) || []).forEach(eid =>
			pipe.eval(
				`local m=redis.call('ZRANGE',KEYS[1],0,-1) for _,v in ipairs(m) do if v==ARGV[1] or string.sub(v,1,#ARGV[2])==ARGV[2] then redis.call('ZREM',KEYS[1],v) end end`,
				1,
				`${REDIS_KEYS.friendlyEveScoredUserIDs}:${eid}`,
				uid,
				`${uid}_`
			)
		);
	}

	linkRows.forEach(({ user: u, user2: u2 }) => {
		if (targetIds.has(u) !== targetIds.has(u2)) pipe.srem(`${REDIS_KEYS.links}:${targetIds.has(u) ? u2 : u}`, targetIds.has(u) ? u : u2);
	});
	blockRows.forEach(({ user: u, user2: u2 }) => {
		if (targetIds.has(u) !== targetIds.has(u2)) pipe.srem(`${REDIS_KEYS.blocks}:${targetIds.has(u) ? u2 : u}`, targetIds.has(u) ? u : u2);
	});
	invitesRows.forEach(({ user2, event }) => pipe.srem(`${REDIS_KEYS.invites}:${user2}`, event));

	await pipe.exec();
}
