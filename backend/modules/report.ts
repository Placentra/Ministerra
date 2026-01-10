import { Sql, Catcher, Redis } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { generateIDString } from '../utilities/idGenerator';

// REPORT MODULE ----------------------------------------------------------------
// Persists abuse reports and rate-limits submissions via redis counter buckets.

const logger = getLogger('Report');

const REPORT_RATE_LIMIT_WINDOW_SEC = 3600; // 1 hour
const REPORT_RATE_LIMIT_MAX = 10; // Max 10 reports per hour per user

// REPORT HANDLER --------------------------------------------------------------

// REPORT ---
// Persists abuse reports and enforces rate limits.
// Steps: validate input, apply per-user redis rate limit, then insert report row into SQL; redis failures don’t block persistence (best-effort limiting).
const Report = async (req, res) => {
	const { userID, mode, target, message = null, severity, reason } = req.body;

	// VALIDATION -------------------------------------------------------------
	// Steps: require core fields and restrict allowed mode strings so reports stay queryable and safe downstream.
	if (!userID || !mode || !target || !reason) {
		return res.status(400).json({ error: 'Missing required fields: userID, mode, target, and reason are required' });
	}
	const allowedModes = ['event', 'user', 'comment', 'chat', 'message'];
	if (!allowedModes.includes(mode)) {
		return res.status(400).json({ error: 'Invalid report mode' });
	}

	let con;
	try {
		// RATE LIMITING -------------------------------------------------------
		// Steps: use an incr+expire bucket; when over limit, return 429 without touching SQL.
		try {
			const redis = await Redis.getClient();
			const rateLimitKey = `report_rl:${userID}`;
			const count = await redis.incr(rateLimitKey);
			if (count === 1) {
				await redis.expire(rateLimitKey, REPORT_RATE_LIMIT_WINDOW_SEC);
			}
			if (count > REPORT_RATE_LIMIT_MAX) {
				logger.alert('Report rate limit exceeded', { userID, count, limit: REPORT_RATE_LIMIT_MAX });
				return res.status(429).json({ error: 'Too many reports. Please try again later.' });
			}
		} catch (redisErr) {
			logger.alert('Report rate limit check failed', { error: redisErr?.message, userID });
		}

		// PERSISTENCE ---------------------------------------------------------
		// Steps: generate Snowflake ID, insert into SQL after rate limit check; logs include skipRateLimit to avoid recursion.
		con = await Sql.getConnection();
		logger.info('report.create', { mode, target, userID, reason, severity, hasMessage: Boolean(message), __skipRateLimit: true });
		const reportID = generateIDString();
		const query = `INSERT INTO reports (id, type, target, user, reason, severity, message) VALUES (?, ?, ?, ?, ?, ?, ?)`;
		await con.execute(query, [reportID, mode, target, userID, reason, severity || 'medium', message]);
		res.status(200).end();
	} catch (error) {
		logger.error('Report', { error, mode, target, userID, reason, severity });
		Catcher({ origin: 'Report', error, res });
	} finally {
		if (con) con.release();
	}
};

export default Report;
