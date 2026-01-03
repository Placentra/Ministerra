import { Catcher, Sql } from '../systems/systems.ts';
import { encode } from 'cbor-x';
import { getLogger } from '../systems/handlers/logging/index.ts';

const privs = new Set(['pub', 'lin', 'own', 'tru', null]);
const inters = new Set(['sur', 'may', 'int', 'surMay', 'surInt', 'maySur', 'mayInt', 'minSur', 'minMay', 'minInt', 'intMay', 'intSur', 'intPriv', 'mayPriv', 'surPriv']);

let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Interests pushes deltas into redis stream `newEveInters` for async aggregation.
const ioRedisSetter = redisClient => (redis = redisClient);
const STREAM_MAXLEN = Number(process.env.STREAM_MAXLEN) || 50000;
const logger = getLogger('Interests');

// INTERESTS HANDLER -----------------------------------------------------------

// INTERESTS ---
// Handles user attendance toggles (sure/maybe/interested) and privacy switches.
// Persists eve_inters rows and pushes deltas into Redis streams for workers.
// Steps: validate transition, compute deltas, write eve_inters (insert/update), then append a delta payload to `newEveInters` stream so workers can aggregate counters.
const Interests = async (reqOrParams, res = null) => {
	const { eventID, userID, inter = null, priv = 'pub', con: incomingCon = null } = reqOrParams.body || reqOrParams;
	if (!inters.has(inter) || !privs.has(priv)) {
		return res?.status(400).json({ error: 'badRequest' });
	}
	try {
		const con = incomingCon ?? (await Sql.getConnection());
		try {
			// DELTA MAPPING ------------------------------------------------------
			// Steps: map client “transition” into (1) score deltas and (2) resulting inter state; this keeps DB write + stream payload consistent.
			const map = {
				sur: { d: [1, 0, 0], to: 'sur' },
				may: { d: [0, 1, 0], to: 'may' },
				int: { d: [0, 0, 1], to: 'int' },
				surMay: { d: [1, -1, 0], to: 'sur', from: 'may' },
				surInt: { d: [1, 0, -1], to: 'sur', from: 'int' },
				maySur: { d: [-1, 1, 0], to: 'may', from: 'sur' },
				mayInt: { d: [0, 1, -1], to: 'may', from: 'int' },
				intSur: { d: [-1, 0, 1], to: 'int', from: 'sur' },
				intMay: { d: [0, -1, 1], to: 'int', from: 'may' },
				minSur: { d: [-1, 0, 0], to: 'del', from: 'sur' },
				minMay: { d: [0, -1, 0], to: 'del', from: 'may' },
				minInt: { d: [0, 0, -1], to: 'del', from: 'int' },
				surPriv: { d: [0, 0, 0], to: 'sur', onlyPriv: true },
				mayPriv: { d: [0, 0, 0], to: 'may', onlyPriv: true },
				intPriv: { d: [0, 0, 0], to: 'int', onlyPriv: true },
			};
			const cfg = map[inter];
			const [surD, mayD, intD] = cfg.d;
			const toInter = cfg.to;
			const finalInter = cfg.from && toInter === 'del' ? 'del' : toInter;

			// QUERY CONSTRUCTION -------------------------------------------------
			// Steps: choose INSERT...ON DUPLICATE semantics:
			// - priv-only: update priv only when changed
			// - from->to: update inter only when current state matches expected from (guards against stale client)
			// - direct set: update inter when different
			let sql, params;
			if (cfg.onlyPriv) {
				sql = `INSERT INTO eve_inters (user, event, inter, priv)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        priv = CASE WHEN priv <> VALUES(priv) THEN VALUES(priv) ELSE priv END`;
				params = [userID, eventID, toInter, priv];
			} else if (cfg.from) {
				sql = `INSERT INTO eve_inters (user, event, inter, priv)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        inter = CASE WHEN inter = ? THEN VALUES(inter) ELSE inter END`;
				params = [userID, eventID, toInter, priv, cfg.from];
			} else {
				sql = `INSERT INTO eve_inters (user, event, inter, priv)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        inter = CASE WHEN inter <> VALUES(inter) THEN VALUES(inter) ELSE inter END`;
				params = [userID, eventID, toInter, priv];
			}

			const [result] = await con.execute(sql, params);
			const didInsert = result?.affectedRows === 1;
			const didUpdate = result?.affectedRows === 2; // ON DUPLICATE KEY triggered

			// STREAM NOTIFICATION ------------------------------------------------
			// Steps: only emit stream delta when a row was inserted/updated; no-op updates should not create downstream work.
			if (didInsert || didUpdate) {
				await redis.xadd('newEveInters', 'MAXLEN', '~', STREAM_MAXLEN, '*', 'payload', encode([eventID, userID, surD, mayD, intD, priv, finalInter]));
			}

			res?.status(200).end();
		} finally {
			try {
				if (!incomingCon) con.release();
			} catch (error) {
				logger.error('Interests', { error, userID, eventID, step: 'releaseConnection' });
			}
		}
	} catch (error) {
		logger.error('Interests', { error, userID, eventID, inter, priv });
		Catcher({ origin: 'Interests', error, res });
	}
};
export { Interests, ioRedisSetter };
