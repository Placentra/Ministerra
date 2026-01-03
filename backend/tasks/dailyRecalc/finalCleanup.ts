// FINAL CLEANUP ================================================================
import { getIDsString } from '../../../shared/utilities.ts';
import { Querer } from '../../systems/systems.ts';
import { loadMetaPipes, loadBasicsDetailsPipe, clearState } from '../../utilities/contentHelpers.ts';
import { getLogger } from '../../systems/handlers/logging/index.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

// NOTE: Type-only capability declarations removed (minimal backend typing).

const logger = getLogger('Task:DailyRecalc:FinalCleanup');

// REFRESH TOP 100 EVENTS -------------------------------------------------------
// Steps: compute top 100 ids from SQL, hmget their metas from redis, then replace topEvents hash in one pipeline so readers see a single coherent snapshot.
export async function refreshTop100Events({ con, redis }) {
	// QUERY RESULT SHAPE -------------------------------------------------------
	// Steps: only `id` is used; keep the row type minimal and local to this function.
	let rows = [];
	try {
		rows = (await con.execute(`SELECT id FROM events WHERE starts > CURDATE() AND priv = 'pub' AND type NOT LIKE 'a%' ORDER BY 3 * surely + 2 * maybe + score DESC LIMIT 100`))[0];
	} catch (e) {
		logger.error('dailyRecalc.top_events_query_failed', { e });
		throw e;
	}

	const ids = rows.map(r => r.id);
	if (!ids.length) return;

	try {
		// REDIS META SNAPSHOT ---------------------------------------------------
		// Steps: hmgetBuffer gives (Buffer|null) array; keep only hits so HSET payload is compact.
		const metas = await redis.hmgetBuffer(REDIS_KEYS.eveMetas, ...ids),
			map = new Map();
		metas.forEach((m, i) => m && map.set(ids[i], m));
		if (map.size)
			await redis
				.pipeline()
				.del(REDIS_KEYS.topEvents)
				.hset(REDIS_KEYS.topEvents, ...[...map].flat())
				.exec();
	} catch (e) {
		logger.error('dailyRecalc.best_of_pipeline_failed', { e, count: ids.length });
		throw e;
	}
}

// EXECUTE FINAL PARALLEL QUERIES ------------------------------------------------
// Steps: run housekeeping SQL updates/deletes in an atomic sequence, then advance last_daily_recalc and clear daily counters so the next day starts clean.
export async function executeFinalQueries({ con, redis, inaUse }) {
	const queries = [
		...(inaUse.size ? [`UPDATE logins SET inactive = TRUE WHERE user IN (${getIDsString(inaUse)})`] : []),
		`UPDATE users SET status = "user" WHERE status = "newUser" AND created < CURDATE() - INTERVAL 3 MONTH`,
		`UPDATE rem_events SET flag = "don" WHERE flag = "del"`,
		`UPDATE rem_users SET flag = "don" WHERE flag = "del"`,
		`UPDATE fro_users SET flag = "don" WHERE flag = "fro"`,
		`UPDATE changes_tracking SET changed_name = FALSE WHERE changed_name = TRUE`,
		`DELETE FROM rjwt_tokens WHERE created < NOW() - INTERVAL 3 DAY`,
		`DELETE FROM user_alerts WHERE created < NOW() - INTERVAL 3 MONTH`,
		`DELETE FROM user_links WHERE changed < NOW() - INTERVAL 3 MONTH AND link = 'req'`,
	];
	try {
		await Querer({ con, queries, task: 'dailyRecalc', mode: 'atomic_seq' });
	} catch (e) {
		logger.error('dailyRecalc.parallel_queries_failed', { e, queries });
		throw e;
	}

	await con.execute(`UPDATE miscellaneous SET last_daily_recalc = NOW()`);
	await Promise.all([redis.del(REDIS_KEYS.dailyLinkReqCounts), redis.del(REDIS_KEYS.dailyIpRegisterCounts)]);
}

// CLEANUP OLD REMUSE ENTRIES ---------------------------------------------------
// Steps: prune very old remUse timestamps so the hash stays bounded; keep newer entries to gate repeat processing.
export async function cleanupOldRemUse({ redis, now }) {
	const old = Object.entries((await redis.hgetall(REDIS_KEYS.remUse)) || {})
		.filter(([, ts]) => Number(ts) < now - 15552000000)
		.map(([k]) => k);
	if (old.length) await redis.hdel(REDIS_KEYS.remUse, ...old);
}

// EXECUTE STATE PIPELINES ------------------------------------------------------
// Steps: fill pipelines from in-memory state, exec all three in parallel (metas/basi/attend), then clear state to avoid cross-run leakage.
export async function executeStatePipes({ redis, state }) {
	const [metaPipe, basicsPipe, attendPipiline] = Array.from({ length: 3 }, () => redis.pipeline());
	loadMetaPipes(state, metaPipe, attendPipiline, 'dailyRecalc');
	loadBasicsDetailsPipe(state, basicsPipe);
	await Promise.all(
		[metaPipe, basicsPipe, attendPipiline].map(p =>
			p.exec().catch(e => {
				logger.error('dailyRecalc.pipe_failed', { e });
				throw e;
			})
		)
	);
	clearState(state);
}
