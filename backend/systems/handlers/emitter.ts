import { getSocketIOInstance, getOnlineStatus } from '../socket/socket.ts';
import { Writer } from '../systems.ts';
import { encode, decode } from 'cbor-x';
import { getLogger } from './loggers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('Emitter');

// CORE EMITTER LOGIC ------------------------------------------------------------
// Orchestrates alert fanout:
// - normalizes alert inputs from worker tasks (interactions/comments/invites/ratings)
// - enriches payloads with event/user/comment metadata (redis-first, SQL fallback)
// - delivers to online users via Socket.IO and marks offline users in redis summary
// - persists stored alerts into SQL for inbox/history
// Steps: collect unique IDs, batch-enrich via redis/sql, build per-recipient queues, emit to online users, mark offline users, then bulk-persist stored alerts.
async function Emitter(data, con, redis) {
	try {
		const { interactionsAlerts = [], commentsAlerts = [], userRatingsMap = new Map(), userInvitesMap = new Map() } = data;

		// 1) DATA COLLECTION ---------------------------------------------------------
		// Steps: gather unique entity IDs needed for enrichment so the enrichment phase can be fully batched.
		const [uniqueEventIds, uniqueCommentIds, uniqueUserIds] = [new Set(), new Set(), new Set()];
		// Helper to normalize and add non-null IDs to sets
		const add = (set, id) => id != null && set.add(String(id));

		// Interactions: Collect IDs from likes, ratings, etc.
		for (const { what, target } of interactionsAlerts) {
			if (['interest', 'eve_rating'].includes(what)) add(uniqueEventIds, target);
			else if (what === 'comm_rating') add(uniqueCommentIds, target);
		}

		// Comments/Replies: Collect IDs from new comments and reply targets
		for (const { what, target, data: cData } of commentsAlerts) {
			if (what === 'comment') {
				add(uniqueEventIds, target);
				add(uniqueUserIds, cData?.user);
			} else if (what === 'reply') {
				add(uniqueCommentIds, target);
				add(uniqueUserIds, cData?.user);
				add(uniqueEventIds, cData?.event);
			}
		}

		// Invites: Collect IDs from user invites
		for (const invites of userInvitesMap.values()) {
			for (const { target, data: iData } of invites) {
				add(uniqueEventIds, target);
				add(uniqueUserIds, iData.user);
			}
		}

		// 2) DATA ENRICHMENT ---------------------------------------------------------
		// Steps: hmgetBuffer in batch, SQL fetch only for misses, then backfill redis so repeated alerts become cheaper.
		const [eventData, commentData, userData] = await Promise.all([
			fetchEntityData([...uniqueEventIds], 'eveTitleOwner', redis, con, 'events', ['id', 'title', 'owner'], r => ({ id: r.id, title: r.title, owner: r.owner })),
			fetchEntityData([...uniqueCommentIds], 'commentAuthorContent', redis, con, 'comments', ['id', 'user AS author', 'content'], r => ({
				author: r.author,
				content: r.content ? r.content.substring(0, 50) : '',
			})),
			fetchEntityData([...uniqueUserIds], 'userNameImage', redis, con, 'users', ['id', 'first', 'last', 'imgVers'], r => ({ id: r.id, first: r.first, last: r.last, imgVers: r.imgVers })),
		]);

		// 3) ALERT CONSTRUCTION ------------------------------------------------------
		// Steps: normalize payload shapes, attach lightweight enrichment, group by recipient, and stage rows for SQL persistence.
		const alertsByRecipient = new Map(),
			dbAlerts = [];

		// Helper: Adds alert to memory map and DB queue
		// Steps: normalize recipient id, stage alert for socket fanout, and stage SQL row only when store=true.
		const pushAlert = (recipient, what, target, dataObj, store = true) => {
			if (!recipient) return;
			const normRec = String(recipient);
			if (!alertsByRecipient.has(normRec)) alertsByRecipient.set(normRec, []);
			alertsByRecipient.get(normRec).push({ what, target, data: dataObj, store });
			if (store) dbAlerts.push([normRec, what, target, JSON.stringify(dataObj)]);
		};
		// Helper: Hydrates title if missing
		const setTitle = (obj, id) => {
			if (eventData[String(id)]?.title) obj.title ??= eventData[String(id)].title;
		};
		// Helper: Hydrates user info
		const userBrief = id => ({ user: id, ...(userData[String(id)] || {}) });

		// PROCESS: Interactions
		for (const { what, target, data: iData = {} } of interactionsAlerts) {
			const tKey = String(target),
				eventInfo = eventData[tKey];
			// Determine recipient based on interaction type
			const recipient = what === 'comm_rating' ? commentData[tKey]?.author : what === 'user_rating' ? target : eventInfo?.owner;
			if (!recipient) continue;

			if (what === 'comm_rating') iData.content = commentData[tKey]?.content || '';
			else if (what !== 'user_rating') setTitle(iData, tKey);

			// Flatten counts/points structure for frontend
			if (what === 'interest') {
				Object.assign(iData, { event: target, ...iData.counts });
				delete iData.counts;
			} else if (what === 'eve_rating') {
				Object.assign(iData, { event: target, points: iData.points ?? iData.counts });
				delete iData.counts;
			}

			pushAlert(recipient, what, target, iData);
		}

		// PROCESS: Comments & Replies
		for (const { what, target, data: cData = {} } of commentsAlerts) {
			const isComm = what === 'comment',
				tKey = String(target);
			const recipient = isComm ? eventData[tKey]?.owner : commentData[tKey]?.author;

			// Skip if no recipient or self-reply
			if (!recipient || recipient === cData.user) continue;

			// Attach user info and context (original comment content if reply)
			Object.assign(cData, userBrief(cData.user), !isComm ? { original: commentData[tKey]?.content || '' } : {});
			setTitle(cData, isComm ? tKey : cData.event);
			pushAlert(recipient, what, target, cData);
		}

		// PROCESS: User Ratings (Pre-grouped)
		for (const [id, alerts] of userRatingsMap) alerts.forEach(({ what, target, data: rData }) => pushAlert(id, what, target, rData));

		// PROCESS: Invites
		for (const [recId, invites] of userInvitesMap) {
			for (const { target: eId, data: iData } of invites) {
				const sender = iData?.user;
				if (!sender || !userData[String(sender)]) continue;

				// Construct clean payload (remove server-only flags)
				const payload = { ...userBrief(sender), ...iData, event: eId, title: eventData[String(eId)]?.title, dir: iData.dir || 'in', flag: iData.flag || 'ok' };
				delete payload.storeAlert;
				delete payload.user;
				if (iData.note) payload.note = iData.note;

				// Only store if explicit (not skipped) and not a deletion
				pushAlert(recId, 'invite', eId, payload, iData.storeAlert !== false && payload.flag !== 'del');
			}
		}

		// 4) DELIVERY ----------------------------------------------------------------
		// Steps: partition recipients by online status, set summary flags for offline users, emit to online users via Socket.IO.
		const recipients = [...alertsByRecipient.keys()];
		const { online, offline } = await getOnlineStatus(recipients);

		// Offline processing: Mark "Notification Dots" in Redis
		if (offline.size) {
			const pipe = redis.pipeline();
			offline.forEach(id => alertsByRecipient.get(id).some(a => a.store) && pipe.hset(`${REDIS_KEYS.userSummary}:${id}`, 'alerts', 1));
			await pipe.exec();
		}

		// Online processing: Emit via Socket.IO
		// SOCKET INSTANCE --------------------------------------------------------
		const socketIO = getSocketIOInstance();
		if (socketIO) {
			for (const [id, alerts] of alertsByRecipient) {
				if (online.has(id)) alerts.forEach(alert => socketIO.to(String(id)).emit(alert.what, { target: alert.target, data: alert.data }));
			}
		}

		// 5) PERSISTENCE -------------------------------------------------------------
		// Steps: bulk insert stored alerts only (skip transient/cleanup alerts) so inbox/history stays consistent.
		if (dbAlerts.length) {
			await Writer({ mode: 'userAlerts', tasksConfig: [{ arrs: dbAlerts, table: 'user_alerts', cols: ['user', 'what', 'target', 'data'], is: 'insert' }], redis, con });
		}
	} catch (error) {
		logger.error('emitter.unhandled', { error });
	}
}

// GENERIC DATA FETCHER ----------------------------------------------------------
// Unified entity fetcher used by the emitter:
// - attempts redis hash lookup first (binary CBOR payloads)
// - falls back to SQL for missing IDs
// - backfills redis to keep subsequent alerts cheap
// Return shape is a plain object keyed by normalized string ID.
// Steps: hmgetBuffer all IDs, decode successful hits, collect misses, SQL fetch misses, encode+backfill redis, then return merged object map.
async function fetchEntityData(ids, cacheKey, redis, con, table, cols, mapper) {
	if (!ids?.length) return {};
	const normIds = ids.map(String),
		result = {},
		missing = [];

	try {
		const pipe = redis.pipeline();
		normIds.forEach(id => pipe.hgetBuffer(cacheKey, id));
		(await pipe.exec()).forEach(([, buf], i) => {
			if (buf) {
				try {
					const decoded = decode(buf);
					// Reconstruct object based on cacheKey type logic
					if (cacheKey === 'eveTitleOwner') result[normIds[i]] = { id: normIds[i], title: decoded[0], owner: decoded[1] };
					else if (cacheKey === 'commentAuthorContent') result[normIds[i]] = { author: decoded[0], content: decoded[1] || '' };
					else if (cacheKey === 'userNameImage') result[normIds[i]] = { first: decoded[0], last: decoded[1], imgVers: decoded[2] };
				} catch {
					missing.push(normIds[i]);
				}
			} else missing.push(normIds[i]);
		});

		if (missing.length) {
			const [rows] = await con.execute(`SELECT ${cols.join(',')} FROM ${table} WHERE id IN (${missing.map(() => '?').join(',')})`, missing);
			if (rows?.length) {
				const updatePipe = redis.pipeline();
				for (const row of rows) {
					const strId = String(row.id),
						obj = mapper(row);
					result[strId] = obj;
					// Encode logic mirrors the decode logic above
					const val =
						cacheKey === 'eveTitleOwner'
							? [obj.title || '', obj.owner || '']
							: cacheKey === 'commentAuthorContent'
							? [obj.author || '', obj.content]
							: [obj.first || '', obj.last || '', obj.imgVers || ''];
					updatePipe.hset(cacheKey, strId, encode(val));
				}
				await updatePipe.exec();
			}
		}
	} catch (error) {
		logger.error(`fetch_${table}_failed`, { error });
	}
	return result;
}

// USER DATA FETCH (CONVENIENCE) ------------------------------------------------
// Wrapper for the most common emitter enrichment need (user name/image payload).
const fetchUserData = (ids, redis, con) =>
	fetchEntityData(ids, 'userNameImage', redis, con, 'users', ['id', 'first', 'last', 'imgVers'], r => ({ id: r.id, first: r.first, last: r.last, imgVers: r.imgVers }));

export { Emitter, fetchUserData };
