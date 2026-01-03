// REDIS CACHING HELPERS ========================================================
// Cache user relationships (links, blocks, invites, trusts) to avoid repeated SQL queries.
// =============================================================================

import { Sql } from '../../systems/mysql/mysql';
import { getLogger } from '../../systems/handlers/logging/index';
// ANNOTATION STRATEGY: External types -----------------------------------------
import { Redis } from 'ioredis';

const logger = getLogger('Helpers:Cache');

let redis;
export const ioRedisSetter = r => (redis = r);

// GET OR CACHE FILTERING SETS --------------------------------------------------
// Steps: try reading from Redis first; if missing, fall back to SQL, cache the result, and return it.
// forceSql bypasses the initial Redis read (e.g. for re-syncing).
export async function getOrCacheFilteringSets(con, targetSet, userID, forceSql = false) {
	let query: string,
		obtainedCon = false;
	try {
		// REDIS CACHE CHECK ---
		// Steps: if not forcing SQL, check if the set exists in Redis.
		const key = `${targetSet}:${userID}`;
		if (!forceSql) {
			const exists = await redis.exists(key);
			if (exists) {
				const members = await redis.smembers(key);
				return new Set(members);
			}
		}

		if (!con) {
			con = await Sql.getConnection();
			obtainedCon = true;
		}

		if (targetSet === 'invites') {
			// INVITES MODE ---
			// Steps: query invited event IDs, then cache as a Redis Set so membership checks become O(1) without SQL.
			query = /*sql*/ `SELECT event FROM eve_invites WHERE user2 = ?`;

			const [rows] = await con.execute(query, [userID]);
			const values = rows.map((row: any) => row.event);

			if (values.length) {
				const multi = redis.multi();
				multi.sadd(`${targetSet}:${userID}`, ...values);
				await multi.exec();
			}
			return new Set(values);
		}

		if (targetSet === 'links' || targetSet === 'blocks' || targetSet === 'trusts') {
			// USER RELATION MODE ---
			// Steps: select both columns, then compute “the other user” for each row so the cached Set contains only peers.
			query =
				targetSet === 'blocks'
					? /*sql*/ `SELECT user, user2 FROM user_blocks WHERE user = ? OR user2 = ?`
					: targetSet === 'trusts'
					? /*sql*/ `SELECT user, user2 FROM user_links WHERE ((user = ? AND who IN (1, 3)) OR (user2 = ? AND who IN (2, 3))) AND link = 'tru'`
					: /*sql*/ `SELECT user, user2 FROM user_links WHERE (user = ? OR user2 = ?) AND link = 'ok'`;

			const [rows] = await con.execute(query, [userID, userID]);
			const otherUserIds = [];

			for (const row of rows) {
				const { user, user2 } = row;
				// PEER EXTRACTION ---
				// Steps: keep the non-requester side so the stored set is “IDs related to me”, not raw edge rows.
				const otherUser = user === userID ? user2 : user;
				if (otherUser) otherUserIds.push(otherUser);
			}

			if (otherUserIds.length) {
				const multi = redis.multi();
				multi.sadd(`${targetSet}:${userID}`, ...otherUserIds);
				await multi.exec();
			}
			return new Set(otherUserIds);
		}

		// UNKNOWN MODE ---
		// Steps: return empty set so callers can proceed without special-casing missing caches.
		return new Set();
	} catch (error) {
		logger.error('helpers.get_and_cache_missing_failed', { error, targetSet, userID, query: query! });
		throw error;
	} finally {
		// CONNECTION CLEANUP ---
		// Steps: only release if acquired here so upstream transaction scopes remain intact.
		if (obtainedCon && con) con.release();
	}
}
