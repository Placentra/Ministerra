// DAILY RECALC - MAIN ORCHESTRATOR =============================================
import { Catcher } from '../../systems/systems.ts';
import { processUserMetas, processRemEveMetas, getStateVariables } from '../../utilities/contentHelpers.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { recalcPastEvents, recalcAffectPastEveUsers } from './pastEvents.ts';
import { removeInactiveUserSetsFromRedis, updateRedisUserSets } from './userCleanup.ts';
import { updateChatsChangedStatus, updateChatDeadStatus } from './chatCleanup.ts';
import { buildRecalcQueries, executeRecalcQueries, cleanupDeletedUsersRedis, cleanupRemovedEventsRedis } from './deletionQueries.ts';
import { refreshTop100Events, executeFinalQueries, cleanupOldRemUse, executeStatePipes } from './finalCleanup.ts';
import { cleanupDeletedFiles } from './fileCleanup.ts';

const logger = getLogger('Task:DailyRecalc'),
	REDIS_USERSET_BATCH_LIMIT = Number(process.env.DAILY_RECALC_REDIS_USERSET_BATCH) || 0;

// SQL EXPRESSIONS ---------------------------
const nullEndClause = `ends IS NULL,TIMESTAMP(DATE(DATE_ADD(starts, INTERVAL 48 HOUR)) + INTERVAL (TIME(DATE_ADD(starts, INTERVAL 48 HOUR)) > '00:00:00') DAY),GREATEST(TIMESTAMP(DATE(DATE_ADD(starts, INTERVAL 48 HOUR)) + INTERVAL (TIME(DATE_ADD(starts, INTERVAL 48 HOUR)) > '00:00:00') DAY),TIMESTAMP(DATE(ends) + INTERVAL (TIME(ends) > '00:00:00') DAY))`;
const rankExpr = `(3 * surely + 2 * maybe + score)`;
const daysExpr = `CASE WHEN ${rankExpr} >= 4000 THEN 7 WHEN ${rankExpr} >= 1500 THEN 6 WHEN ${rankExpr} >= 600 THEN 5 WHEN ${rankExpr} >= 200 THEN 4 WHEN ${rankExpr} >= 50 THEN 3 ELSE 2 END`;
const baseTimeExpr = `DATE_ADD(starts, INTERVAL (${daysExpr}) DAY)`,
	endsBoundaryExpr = `TIMESTAMP(DATE(ends) + INTERVAL (TIME(ends) > '00:00:00') DAY)`;
const roundedExpr = `CASE WHEN (${daysExpr}) < 5 THEN TIMESTAMP(DATE(${baseTimeExpr})) ELSE TIMESTAMP(DATE(${baseTimeExpr}) + INTERVAL 1 DAY) END`;

async function dailyRecalcWorker(con, redis) {
	try {
		// CONNECTION OWNERSHIP ---------------------------------------------------
		// The scheduler passes a per-task pooled connection that it releases in its finally block.
		// Tasks must NOT call con.release()/destroy(); the worker handles cleanup.
		await con.execute(`SET time_zone = '+00:00'`);
		const state = getStateVariables(),
			now = Date.now(),
			userMetasProcessor = p => processUserMetas({ ...p, state, redis }),
			remEveMetasProcessor = p => processRemEveMetas({ ...p, state, redis });

		// MAIN INPUT SETS -------------------------------------------------------
		// Steps: fetch the primary ID sets (inactive/frozen/deleted/canceled/etc.) serially so failures are surfaced early and log context is clean.
		const mainQueries = {
				inaUse: `SELECT user as id FROM logins WHERE last_seen < CURDATE() - INTERVAL 3 MONTH AND inactive = FALSE`,
				froUse: `SELECT id FROM fro_users WHERE flag = 'fro'`,
				delFroUse: `SELECT id FROM fro_users WHERE created < CURDATE() - INTERVAL 6 MONTH AND flag != 'unf'`,
				unfUse: `SELECT id FROM fro_users WHERE flag = 'unf'`,
				delEve: `SELECT id FROM rem_events WHERE flag = 'del'`,
				delUse: `SELECT id FROM rem_users WHERE flag = 'del'`,
				canEve: `SELECT id FROM events WHERE flag = 'can' AND (starts < NOW() OR changed < CURDATE() - INTERVAL 3 MONTH)`,
				newNameUse: `SELECT user as id FROM changes_tracking WHERE changed_name = TRUE`,
			},
			sets: any = {};

		for (const [k, q] of Object.entries(mainQueries))
			try {
				sets[k] = new Set((await con.execute(q))[0].map(r => r.id));
			} catch (e) {
				logger.error('dailyRecalc.fetch_query_failed', { e, k, q });
				throw e;
			}
		const { inaUse, froUse, delFroUse, unfUse, delEve, delUse, canEve, newNameUse } = sets;

		// LIVE_UNTIL NORMALIZATION ----------------------------------------------
		// Steps: update live_until for active/past detection, then select past events based on live_until boundary.
		await con.execute(
			`UPDATE events SET live_until = IF(${nullEndClause}) WHERE flag = 'ok' AND starts < NOW() AND type LIKE 'a%' AND (live_until IS NULL OR live_until < IF(${nullEndClause})) LIMIT 50000`
		);
		await con.execute(
			`UPDATE events SET live_until = IF(ends IS NULL, ${roundedExpr}, GREATEST(${roundedExpr}, ${endsBoundaryExpr})) WHERE flag = 'ok' AND starts < NOW() AND type NOT LIKE 'a%' AND live_until IS NULL LIMIT 50000`
		);
		await con.execute(
			`UPDATE events SET live_until = GREATEST(live_until, ${endsBoundaryExpr}) WHERE flag = 'ok' AND starts < NOW() AND type NOT LIKE 'a%' AND ends IS NOT NULL AND live_until IS NOT NULL AND live_until < ${endsBoundaryExpr} LIMIT 50000`
		);

		const [pastEve] = await con.query(`SELECT id, cityID, type FROM events WHERE live_until <= NOW() AND flag != 'pas'`),
			pastEveIDs = pastEve.map(e => e.id);
		const allDelUserIDs = new Set([...delUse, ...delFroUse]),
			remEventsIDs = new Set([...delEve, ...canEve]);

		// PARALLEL WORK ---------------------------------------------------------
		// Steps: run independent work (past event recalc, user set maintenance, chat status, file cleanup) in parallel for total runtime reduction.
		await Promise.all([
			recalcPastEvents({ redis, pastEveIDs, now, remEveMetasProcessor, userMetasProcessor, state }),
			recalcAffectPastEveUsers({ redis, pastEve, userMetasProcessor }),
			removeInactiveUserSetsFromRedis({ redis, inaUse }),
			updateChatsChangedStatus({ con, redis, allDelUserIDs, delUse, newNameUse, froUse, unfUse, now }),
			updateRedisUserSets({ con, redis, allDelUserIDs, delUse, remEventsIDs, REDIS_USERSET_BATCH_LIMIT }),
			cleanupDeletedFiles({ delUse, delEve }),
		]);

		await updateChatDeadStatus({ con });
		await cleanupRemovedEventsRedis({ con, redis, remEventsIDs });
		await cleanupDeletedUsersRedis({ con, redis, delUse, now });
		await executeRecalcQueries({ con, recalcQs: buildRecalcQueries({ pastEveIDs, remEventsIDs, froUse, delUse, unfUse, delEve }) });

		// FINALIZATION ----------------------------------------------------------
		// Steps: refresh top lists, run final SQL updates, flush state pipelines into redis, then return a compact summary for logs/metrics.
		await refreshTop100Events({ con, redis });
		await executeFinalQueries({ con, redis, inaUse });
		await cleanupOldRemUse({ redis, now });
		await executeStatePipes({ redis, state });

		return {
			success: true,
			processed: {
				pastEvents: pastEveIDs.length,
				frozenUsers: froUse.size,
				deletedFrozenUsers: delFroUse.size,
				deletedEvents: delEve.size,
				deletedUsers: delUse.size,
				unfrozenUsers: unfUse.size,
			},
		};
	} catch (error) {
		logger.error('dailyRecalc.unhandled', { error });
		Catcher({ origin: 'dailyRecalcWorker', error });
		throw error;
	}
}

export default dailyRecalcWorker;
