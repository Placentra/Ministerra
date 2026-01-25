import { Sql, Catcher } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../shared/constants.ts';

interface AlertRequest {
	cursor?: string | number;
	firstID?: string | number;
	lastID?: string | number;
	userID: string | number;
	mode?: 'delete' | 'getNotifDots' | 'list';
	alertId?: string | number;
}

interface NotifDots {
	chats: number;
	alerts: number;
	archive: number;
	lastSeenAlert: number;
}

interface AlertRow {
	id: number;
	user: number;
	what: string;
	target: string;
	data: string | any;
	created: Date | string | number;
	flag: string;
}

interface NormalizedAlert {
	id: number;
	user: number;
	what: string;
	target: string;
	data: any;
	created: Date | string | number;
	flag: string;
}

// TODO need to figure out how to correctly index the table and how to store alets on frontend and how to fetch (FE doesn´t receive IDs, so we can´t cursor based on that. Also cursoring ). For alerts older than 3 months, probably tell FE to not fetch the imgVers for users (since pictures older than 3 months are deleted)

// QUERY DEFINITIONS -----------------------------------------------------------

// USES EXISTS SUBQUERIES ---
// Efficiently checks presence of new alerts or missed chats without counting all rows.
// Used for notification dots (red bubbles) on the UI.
// Steps: use EXISTS probes (bounded work) so “dots” can be computed without scanning full tables.
const summaryQ = `SELECT 
	EXISTS (SELECT 1 FROM user_alerts ua JOIN last_seen ls ON ua.user=ls.user WHERE ua.user=? AND ua.id>ls.alert LIMIT 1) AS hasNewAlerts,
	EXISTS (SELECT 1 FROM chat_members cm JOIN chats c ON cm.chat=c.id JOIN last_seen ls ON cm.seen=ls.mess WHERE cm.id=? AND cm.flag = 'ok' AND c.last_mess>ls.mess LIMIT 1) AS hasMissedChats,
	EXISTS (SELECT 1 FROM chat_members cm WHERE cm.id=? AND cm.archived = TRUE AND cm.miss_arc=1 LIMIT 1) AS hasArchivedChats`;

let redis: any;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Alerts uses redis summary keys to avoid unnecessary SQL reads for notif dots.
export const ioRedisSetter = (redisClient: any) => (redis = redisClient);
const logger = getLogger('Alerts');

interface AlertListResponse {
	data: NormalizedAlert[];
	pagination: {
		hasMore: boolean;
		nextCursor: number | null;
	};
}

// ALERTS HANDLER --------------------------------------------------------------

/** ----------------------------------------------------------------------------
 * ALERTS
 * Synchronizes alert feeds, notification dots and cache coordination for users.
 * Also exposes delete + unread summary helpers consumed by the frontend.
 * Steps: route by mode: (1) delete one alert, (2) read notif dots from Redis with SQL fallback + recache, (3) fetch alerts with cursor/ID bounds and clear dots/pointers.
 * -------------------------------------------------------------------------- */
async function Alerts(req: { body: AlertRequest & { limit?: number } }, res: any = null): Promise<AlertListResponse | NormalizedAlert[] | NotifDots | { success: boolean } | void> {
	const { cursor, firstID, lastID, userID, mode, alertId, limit = 20 } = req.body;
	let con: any,
		payload: AlertListResponse | NormalizedAlert[] | NotifDots | { success: boolean } = [];
	try {
		// DELETE SINGLE ALERT -------------------------------------------------
		if (mode === 'delete') {
			if (!alertId || !userID) throw new Error('badRequest');
			con = await Sql.getConnection();
			await con.execute('DELETE FROM user_alerts WHERE id = ? AND user = ?', [alertId, userID]);
			payload = { success: true };
			return res ? res.status(200).json(payload) : payload;
		}

		// GET NOTIFICATION DOTS -----------------------------------------------
		// Fetch unread indicators (chats, alerts, archives) from Redis or SQL fallback.
		// Returns 1/0 status for each category to toggle UI indicators.
		else if (mode === 'getNotifDots') {
			const [chats, alerts, archive, lastSeenAlert] = await redis.hmget(`${REDIS_KEYS.userSummary}:${userID}`, 'chats', 'alerts', 'archive', 'lastSeenAlert');

			// CACHE MISS: Redis returns null for missing keys -> Rehydrate from DB
			if (chats === null && alerts === null && archive === null && lastSeenAlert === null) {
				// SQL FALLBACK -------------------------------------------------------
				// Steps: use EXISTS probes so DB work is bounded, then recache only when any indicator is non-zero so Redis stays sparse.
				con = await Sql.getConnection();
				const [result]: [any[], any] = await con.execute(summaryQ, [userID, userID, userID]);
				const [[{ lastAlert = 0 } = {}]]: [any[], any] = await con.execute('SELECT COALESCE(alert, 0) AS lastAlert FROM last_seen WHERE user = ?', [userID]);
				// Redis returns strings; '0' is truthy so use explicit null check
				const chatsState = result[0]?.hasMissedChats ? 1 : 0;
				const alertsState = result[0]?.hasNewAlerts ? 1 : 0;
				const archiveState = result[0]?.hasArchivedChats ? 1 : 0;
				const lastSeenAlertState = lastAlert;

				// RE-CACHE STATE (Set Redis keys for subsequent fast reads)
				if (chatsState === 1 || alertsState === 1 || archiveState === 1 || lastSeenAlertState > 0) {
					await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, {
						chats: chatsState,
						alerts: alertsState,
						archive: archiveState,
						lastSeenAlert: lastSeenAlertState,
					});
				}
				payload = { chats: chatsState, alerts: alertsState, archive: archiveState, lastSeenAlert: lastSeenAlertState } as NotifDots;
			} else payload = { chats: Number(chats) || 0, alerts: Number(alerts) || 0, archive: Number(archive) || 0, lastSeenAlert: Number(lastSeenAlert) || 0 } as NotifDots;
			return res ? res.status(200).json(payload) : payload;
		}

		// FETCH ALERTS LIST ---------------------------------------------------
		// Paginated alert retrieval with cursor support (firstID/lastID).
		else {
			// VALIDATE PARAMS ---
			// firstID XOR lastID allowed; initial fetch (no cursor, no IDs) is valid
			if (firstID && lastID) throw new Error('badRequest');

			// CACHE CHECK ---
			// If asking for *new* alerts, check Redis flag first to skip DB hit if no new alerts exist.
			const isFetchingNew = !cursor && firstID;
			if (isFetchingNew) {
				// FAST NO-OP ---------------------------------------------------------
				// Steps: when redis says there are no new alerts, return [] without hitting SQL.
				const hasNewAlerts = await redis.hget(`${REDIS_KEYS.userSummary}:${userID}`, 'alerts');
				if (hasNewAlerts === '0' || hasNewAlerts === null) {
					payload = { data: [], pagination: { hasMore: false, nextCursor: null } };
					if (res) return res.status(200).json(payload);
					return payload;
				}
			}

			con = await Sql.getConnection();
			let rows: AlertRow[] = [];

			// QUERY BUILDER ---
			const conditions = ['user=?'];
			const params: any[] = [userID];
			if (cursor) {
				conditions.push('id<?');
				params.push(cursor);
			}
			if (lastID) {
				conditions.push('id<?');
				params.push(lastID);
			}
			if (firstID) {
				conditions.push('id>?');
				params.push(firstID);
			}

			const sql = `SELECT id, user, what, target, data, created, flag FROM user_alerts WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ${Number(limit) + 1}`;
			[rows] = await con.execute(sql, params);

			const hasMore = rows.length > limit;
			if (hasMore) rows.pop();

			// UPDATE READ STATUS ---
			// If new alerts fetched, clear notification dot and update last_seen pointer.
			if (rows.length) {
				// POINTER ADVANCE ----------------------------------------------------
				// Steps: clear alerts dot immediately; when fetching the newest page, update last_seen.alert to newest ID for idempotent future comparisons.
				await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'alerts', 0);
				if (!cursor && !lastID) {
					const highestAlertId = rows[0].id;
					await con.execute(`INSERT INTO last_seen (user, alert) VALUES (?, ?) ON DUPLICATE KEY UPDATE alert = VALUES(alert)`, [userID, highestAlertId]);
					await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'lastSeenAlert', highestAlertId);
				}
			}

			// NORMALIZE DATA ---
			const normalizeWhat = (w: string) => (w === 'linked' ? 'accept' : w);
			const parseData = (d: string | any) => {
				try {
					return typeof d === 'string' ? JSON.parse(d) : d || {};
				} catch (error) {
					logger.error('parseData', { error, data: d });
					return {};
				}
			};

			const normalizedData = rows.map(
				(r: AlertRow): NormalizedAlert => ({
					id: r.id,
					user: r.user,
					what: normalizeWhat(r.what),
					target: r.target,
					data: parseData(r.data),
					created: r.created,
					flag: r.flag || 'ok',
				})
			);

			const nextCursor = normalizedData.length > 0 ? normalizedData[normalizedData.length - 1].id : null;

			payload = {
				data: normalizedData,
				pagination: {
					hasMore,
					nextCursor,
				},
			};
		}

		if (res) res.status(200).json(payload);
		return payload;
	} catch (error) {
		logger.error('Alerts', { error, userID });
		Catcher({ origin: 'alerts', error, res });
	} finally {
		if (con) con.release();
	}
}

export default Alerts;
