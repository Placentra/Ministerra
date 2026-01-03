import { Sql, Catcher } from '../systems/systems';
import { getLogger } from '../systems/handlers/logging/index';
import { REDIS_KEYS } from '../../shared/constants';

let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Steps: inject shared redis client so Content can read basi snapshots without importing Redis singleton.
const ioRedisSetter = redisClient => (redis = redisClient);
const logger = getLogger('Content');

// CONSTANTS -------------------------------------------------------------------

const eveSQL = `SELECT ei.event AS id, er.mark, er.awards, ei.inter, ei.priv AS interPriv FROM eve_inters ei LEFT JOIN eve_rating er ON er.event = ei.event AND er.user = ? WHERE ei.user = ? AND ei.event IN`;
const userSQL = `SELECT user2 AS id, mark, awards FROM user_rating WHERE user = ? AND user2 IN`;

// HELPERS ---------------------------------------------------------------------

// SQL LOOKUPS ------------------------------------------------------------------
// These helper functions fetch per-user dynamic overlays (ratings/interactions) from SQL.
// They are only used when devIsStable is false or client explicitly requests getSQL.
// Steps: execute a parameterized IN-clause query for the requested IDs, returning only overlay fields (marks/awards/inter/priv) for merging into cached basics.
const getUserSQLs = (userID, IDs, con) => con.execute(`${userSQL} (${IDs.map(() => '?').join(',')})`, [userID, ...IDs]).then(r => r[0]);
const getEveSQLs = (userID, IDs, con) => con.execute(`${eveSQL} (${IDs.map(() => '?').join(',')})`, [userID, userID, ...IDs]).then(r => r[0]);

// CONTENT HANDLER -------------------------------------------------------------
// TODO put owner into eveBasics and  filter the events by blocked owners

/** ----------------------------------------------------------------------------
 * CONTENT
 * Serves condensed event/user summaries (basi) by fusing Redis snapshots with
 * targeted SQL lookups when dev mode or explicit fetch flags require it.
 * Steps: validate request, filter blocked user IDs (users view), fetch basi payloads from Redis in a pipeline, then optionally overlay SQL-derived per-user fields.
 * -------------------------------------------------------------------------- */
async function Content(req, res) {
	let con;
	let userID, contView;
	try {
		({ userID, contView } = req.body || {});
		const { devIsStable, IDs = [], getSQL = [] } = req.body || {};
		if (!IDs.length || IDs.length > 20 || !contView) return res.status(400).json({ error: 'badRequest' });

		// BLOCK FILTERING -----------------------------------------------------
		// Steps: for user basics, exclude blocked targets so UI does not receive redacted entities as real objects.
		let filteredIDs = IDs;
		if (contView === 'users' && IDs.length) {
			const blocksKey = `${REDIS_KEYS.blocks}:${userID}`;
			const isBlocked = await redis.smismember(blocksKey, ...IDs.map(String));
			filteredIDs = IDs.filter((_, idx) => !isBlocked[idx]);
		}

		const [pipeline, basics] = [redis.pipeline(), {}];

		// REDIS CACHE FETCH ---------------------------------------------------
		// Steps: pipeline hgetall per requested ID, then stitch results back into {id->hash} map.
		if (filteredIDs.length) {
			for (const id of filteredIDs) pipeline.hgetall(contView === 'events' ? `eveBasics:${id}` : `userBasics:${id}`);
			for (const [idx, [err, data]] of (await pipeline.exec()).entries()) if (!err) basics[filteredIDs[idx]] = data;
		}

		// SQL ENRICHMENT ------------------------------------------------------
		// Steps: only hit SQL when devIsStable is false or client explicitly requests getSQL; merge SQL overlay fields onto cached basics.
		if (!devIsStable || getSQL.length) {
			con = await Sql.getConnection();
			const sqlIDs = getSQL.length ? getSQL.filter(id => filteredIDs.includes(id)) : filteredIDs;
			if (sqlIDs.length) {
				const dataSQL = await (contView === 'events' ? getEveSQLs : getUserSQLs)(userID, sqlIDs, con);

				// MERGE ---
				// Overlay SQL results onto cached basics
				for (const item of dataSQL) {
					const existing = basics[item.id];
					existing ? Object.assign(existing, item) : (basics[item.id] = item);
				}
			}
		}
		return res.status(200).json(basics);
	} catch (error) {
		logger.error('Content', { error, userID, contView });
		Catcher({ origin: 'Content', error, res });
	} finally {
		if (con) con.release();
	}
}

export { Content, ioRedisSetter };
