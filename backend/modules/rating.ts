import { Catcher, Sql } from '../systems/systems.ts';
import { encode } from 'cbor-x';
import { getLogger } from '../systems/handlers/loggers.ts';

let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Rating writes to redis streams for async aggregation (userInteractions task).
const ioRedisSetter = redisClient => (redis = redisClient);
const STREAM_MAXLEN = Number(process.env.STREAM_MAXLEN) || 50000;
const SCORE_ABS_MAX = 100;
const logger = getLogger('Rating');

// HELPERS ---------------------------------------------------------------------

// TABLE/KEY RESOLUTION ---------------------------------------------------------
// Steps: translate request mode into (table, targetColumn) so SQL is built from a fixed mapping instead of trusting user input.
function getTableAndKey(mode) {
	if (mode === 'event') return ['eve_rating', 'event'];
	if (mode === 'user') return ['user_rating', 'user2'];
	if (mode === 'comment') return ['comm_rating', 'comment'];
	throw new Error('badRequest');
}

// RATING MODULE ---------------------------------------------------------------

// RATING HANDLER ---
// Handles event/user/comment marks, awards and score deltas capped per user.
// Emits Redis streams for workers to update aggregates.
// Steps: validate input, normalize numeric fields, upsert rating row with per-user score cap, then enqueue a stream payload only when something changed.
async function Rating(req, res) {
	const { userID, mode, targetID, awards, mark, score } = req.body;

	// VALIDATION -------------------------------------------------------------
	// Steps: enforce mode whitelist, prevent self-rating, and clamp numeric bounds so SQL stays predictable and abuse-resistant.
	if (!userID || !mode || !targetID) return res.status(400).json({ reason: 'badRequest' });
	if (!['event', 'user', 'comment'].includes(mode)) return res.status(400).json({ reason: 'badRequest' });
	// Prevent self-rating for user mode
	if (mode === 'user' && String(userID) === String(targetID)) return res.status(400).json({ reason: 'badRequest' });
	// Validate mark is provided and within bounds; awards and score are optional
	if (mark === undefined || Math.abs(mark) > 5 || (awards !== undefined && Math.abs(awards) > 56) || (score !== undefined && Math.abs(score) > SCORE_ABS_MAX))
		return res.status(400).json({ reason: 'badRequest' });

	try {
		// NORMALIZE INPUTS ----------------------------------------------------
		// Steps: coerce to numbers, clamp/bitmask, and ensure awards are zeroed when mark is zero so stored payload stays consistent.
		let m = Number(mark);
		if (!Number.isFinite(m)) m = 0;
		let a = Number(awards);
		if (!Number.isFinite(a)) a = 0;
		if (m === 0) a = 0;
		a = Math.abs(a) & ((1 << 6) - 1);
		let requestedDelta = Number(score);
		if (!Number.isFinite(requestedDelta)) requestedDelta = 0;
		if (Math.abs(requestedDelta) > SCORE_ABS_MAX) requestedDelta = Math.sign(requestedDelta) * SCORE_ABS_MAX;

		// PERSISTENCE ---------------------------------------------------------
		// Steps: open SQL connection, upsert row with ABS(score+delta) cap enforced in SQL, then emit to stream so async aggregators can update totals.
		const con = await Sql.getConnection();
		try {
			const [table, key2] = getTableAndKey(mode);

			// NO PRE-READ --------------------------------------------------------
			// Steps: rely on SQL conditional update instead of reading current score; keeps write path one round-trip.
			const appliedDelta = requestedDelta;

			const sql = `INSERT INTO ${table} (user, ${key2}, mark, awards, score)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    score = CASE WHEN ABS(score + VALUES(score)) <= ${SCORE_ABS_MAX} THEN score + VALUES(score) ELSE score END,
                    mark = CASE WHEN ABS(score + VALUES(score)) <= ${SCORE_ABS_MAX} THEN VALUES(mark) ELSE mark END,
                    awards = CASE WHEN ABS(score + VALUES(score)) <= ${SCORE_ABS_MAX} THEN VALUES(awards) ELSE awards END`;

			const params = [userID, targetID, m, a, appliedDelta];
			const [result] = await con.execute(sql, params);

			const didInsert = result?.affectedRows === 1;
			const didUpdate = result?.affectedRows === 2; // ON DUPLICATE KEY: 2 means row changed, 0 means identical values
			const shouldEnqueue = didInsert || didUpdate;

			// QUEUE UPDATE -------------------------------------------------------
			// Steps: only enqueue when insert/update actually changed data, to keep stream volume bounded.
			if (shouldEnqueue) {
				const targetStream = { event: 'newEveRatings', user: 'newUserRatings', comment: 'newCommRatings' }[mode];
				await redis.xadd(targetStream, 'MAXLEN', '~', STREAM_MAXLEN, '*', 'payload', encode([targetID, userID, m, a, appliedDelta]));
			}
			return res.status(200).end();
		} finally {
			// CLEANUP -------------------------------------------------------------
			// Steps: release SQL connection in all paths; log release failures for debugging without masking main result.
			try {
				con.release();
			} catch (error) {
				logger.error('Rating', { error, userID, mode, targetID, step: 'releaseConnection' });
			}
		}
	} catch (error) {
		logger.error('Rating', { error, userID, mode, targetID });
		Catcher({ origin: 'Rating', error, res });
	}
}

export { Rating, ioRedisSetter };
