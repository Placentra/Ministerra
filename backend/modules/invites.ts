import { Catcher, Sql } from '../systems/systems.ts';
import { encode } from 'cbor-x';
import { getLogger } from '../systems/handlers/loggers.ts';
import { Redis } from 'ioredis';
import { Response } from 'express';

interface InviteRequest {
	mode?: 'list' | 'cancel' | 'delete' | 'accept' | 'refuse' | 'cancelAll' | 'deleteAll' | string;
	userID?: string | number;
	targetUser?: string | number;
	targetEvent?: string | number;
	note?: string;
	userIDs?: (string | number)[];
	eventIDs?: (string | number)[];
	direction?: 'in' | 'out';
	offset?: number;
}

let redis: Redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Invites uses redis streams for async processing and redis presence for availability gating.
const ioRedisSetter = (redisClient: Redis) => (redis = redisClient);
const logger = getLogger('Invites');

// INVITES HANDLER -------------------------------------------------------------

// INVITES ---
// Lists inbound/outbound invites and enqueues invite actions into Redis streams
// for background processing (fan-out, cancellation, accept/refuse, etc.).
// INVITES DISPATCHER -----------------------------------------------------------
// Modes:
// - list: reads invites from SQL (paginated)
// - invite*/cancel*/delete*/accept/refuse: appends an action payload into redis stream for worker processing
// Steps: validate and normalize input, run SQL reads for list mode, otherwise enqueue an action into `newInvites` stream so background workers can fan out and persist.
async function Invites(req: { body: InviteRequest }, res: Response) {
	let con: any;
	const { mode, userID, targetUser, targetEvent, note, userIDs, eventIDs, direction, offset } = req.body || {};
	try {
		// VALIDATION ----------------------------------------------------------
		// Steps: cap note length and batch sizes so single requests can’t create undocumented downstream work.
		const safeNote = typeof note === 'string' ? note.slice(0, 200) : null;
		// Consistent limits: eventIDs max 3 (user can invite to max 3 events), userIDs max 20 (per batch)
		if (eventIDs && (!Array.isArray(eventIDs) || eventIDs.length === 0 || eventIDs.length > 3)) throw new Error('badPayload');
		if (userIDs && (!Array.isArray(userIDs) || userIDs.length === 0 || userIDs.length > 20)) throw new Error('badPayload');

		// LIST INVITES --------------------------------------------------------
		// Steps: validate direction and targetEvent, then run a parameterized query for either incoming or outgoing invites.
		if (mode === 'list') {
			// Validate direction parameter explicitly
			if (direction !== 'in' && direction !== 'out') throw new Error('badPayload');
			const isIn = direction === 'in'; // 'in'  -> invitesIn (current user is invitee)

			con = await Sql.getConnection();
			if (!userID) throw new Error('missingUser');
			// OFFSET NORMALIZATION ----------------------------------------------
			// Steps: enforce non-negative integer offset so pagination remains predictable.
			const safeOffset = Number.isInteger(offset) && offset! >= 0 ? offset : 0;

			// Use parameterized query structure based on direction to prevent SQL injection
			const query = isIn
				? `SELECT u.id, u.first, u.last, u.imgVers, ei.created, ei.flag, ei.note
				   FROM eve_invites ei
				   JOIN users u ON u.id = ei.user
				   WHERE ei.user2 = ? AND ei.event = ?
				   ORDER BY ei.created DESC
				   LIMIT 20 OFFSET ?`
				: `SELECT u.id, u.first, u.last, u.imgVers, ei.created, ei.flag, ei.note
				   FROM eve_invites ei
				   JOIN users u ON u.id = ei.user2
				   WHERE ei.user = ? AND ei.event = ?
				   ORDER BY ei.created DESC
				   LIMIT 20 OFFSET ?`;

			if (!targetEvent) throw new Error('badPayload'); // Require targetEvent for list queries ---------------------------
			const [rows]: [any[], any] = await con.execute(query, [userID, targetEvent, safeOffset]);
			return res.json(rows);
		}

		// ACTIONS VIA STREAM --------------------------------------------------
		// Steps: normalize action name, validate required fields, then enqueue encoded payload to `newInvites` stream for async processing.
		if (!redis) throw new Error('noRedisConnection');

		const action = (() => {
			if (!mode) return userIDs ? 'inviteUsers' : eventIDs ? 'inviteEvents' : null;
			return mode;
		})();

		switch (action) {
			case 'list':
				break; // already handled
			case 'inviteUsers': {
				if (!targetEvent || !userID || !Array.isArray(userIDs) || userIDs.length === 0 || userIDs.length > 20) throw new Error('badPayload');
				const payload = {
					mode: 'inviteUsers',
					event: targetEvent,
					senderId: userID,
					targetUsers: userIDs,
					...(safeNote ? { note: safeNote } : {}),
				};
				try {
					await redis.xadd('newInvites', '*', 'payload', encode(payload));
					return res.status(202).end();
				} catch (err) {
					logger.error('Invites.inviteUsers.redis_failed', { error: err });
					throw new Error('redisError');
				}
			}
			case 'inviteEvents': {
				if (!targetUser || !userID || !Array.isArray(eventIDs) || eventIDs.length === 0 || eventIDs.length > 3) throw new Error('badPayload');
				const payload = {
					mode: 'inviteEvents',
					targetUser,
					senderId: userID,
					events: eventIDs,
					...(safeNote ? { note: safeNote } : {}),
				};
				try {
					await redis.xadd('newInvites', '*', 'payload', encode(payload));
					return res.status(202).end();
				} catch (err) {
					logger.error('Invites.inviteEvents.redis_failed', { error: err });
					throw new Error('redisError');
				}
			}
			case 'cancel':
			case 'delete':
			case 'accept':
			case 'refuse':
				if (!targetUser || !targetEvent || !userID) throw new Error('badPayload');
				try {
					await redis.xadd('newInvites', '*', 'payload', encode({ mode: action, userID, targetUser, targetEvent }));
					return res.status(202).end();
				} catch (err) {
					logger.error('Invites.action.redis_failed', { error: err, mode: action });
					throw new Error('redisError');
				}
			case 'cancelAll':
			case 'deleteAll':
				if (!targetEvent || !userID) throw new Error('badPayload');
				try {
					await redis.xadd('newInvites', '*', 'payload', encode({ mode: action, userID, targetEvent }));
					return res.status(202).end();
				} catch (err) {
					logger.error('Invites.bulk_action.redis_failed', { error: err, mode: action });
					throw new Error('redisError');
				}
			default:
				throw new Error('unknownMode');
		}
	} catch (error) {
		logger.error('Invites', { error, mode, userID, targetUser, targetEvent });
		Catcher({ origin: 'Invites', error, res });
	} finally {
		if (con) con.release();
	}
}

export { Invites, ioRedisSetter };
