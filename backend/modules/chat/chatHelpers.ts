import { Sql } from '../../systems/systems';
import { REDIS_KEYS } from '../../../shared/constants';
import { getLogger } from '../../systems/handlers/logging/index';
import { LRUCache } from 'lru-cache';

const logger = getLogger('ChatHelpers');

// ROLE DEFINITIONS ------------------------------------------------------------
// Steps: define role sets once so authorization checks are cheap and consistent across HTTP + socket entry points.
const ROLES_MAP = {
	all: new Set(['member', 'priv', 'spect', 'gagged', 'guard', 'admin', 'VIP']),
	full: new Set(['member', 'priv', 'guard', 'admin', 'VIP']),
	mod: new Set(['guard', 'admin', 'VIP']),
	admin: new Set(['admin', 'VIP']),
};

const necessaryRoles = {
	adminRoles: ROLES_MAP.mod,
	endChat: ROLES_MAP.admin,
	openChat: ROLES_MAP.all,
	hideChat: ROLES_MAP.all,
	unhideChat: ROLES_MAP.all,
	getMessages: ROLES_MAP.all,
	archiveChat: ROLES_MAP.all,
	leaveChat: new Set([...ROLES_MAP.mod, 'member', 'spect', 'gagged']),
	getMembers: new Set([...ROLES_MAP.mod, 'member', 'priv', 'gagged']),
	deleteMessage: ROLES_MAP.all,
	getRequests: new Set([...ROLES_MAP.mod, 'member']),
	postMessage: ROLES_MAP.full,
	editMessage: new Set([...ROLES_MAP.full, 'gagged']),
	joinRoom: ROLES_MAP.full,
	setupChat: ROLES_MAP.admin,
	reenterChat: new Set(['spect', 'member']),
	approveReq: ROLES_MAP.mod,
	refuseReq: ROLES_MAP.mod,
	ungag: ROLES_MAP.mod,
	kick: ROLES_MAP.mod,
	gag: ROLES_MAP.mod,
	unban: ROLES_MAP.admin,
	ban: ROLES_MAP.admin,
	unblockChat: new Set(['member', 'priv']),
	blockChat: new Set(['member', 'priv']),
};

const needsAuth = new Set(Object.keys(necessaryRoles));
let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Injects the shared redis client so chat helper functions can run without importing Redis singleton.
// This keeps helpers usable from both HTTP modules and socket handlers.
// Steps: accept the shared redis instance once at startup; callers must ensure the client is ready before chat traffic begins.
export const setChatHelpersRedisClient = r => {
	redis = r;
};

// CACHE & TTL ------------------------------------------------------------------
// TTLs keep redis keys fresh and prevent unbounded growth.
// authFails is an in-memory rate limiter for repeated missing-role lookups (DDoS containment).
// membersCache provides micro-caching for member IDs to reduce Redis roundtrips during high activity.
const [MEMBERS_TTL, ROLES_TTL, AUTH_FAIL_TTL, AUTH_FAIL_MAX] = [604800, 86400, 60000, 10000];
const authFails = new Map();
const membersCache = new LRUCache({
	max: 1000, // Track up to 1000 active chats
	ttl: 5 * 60 * 1000, // 5 minute TTL matching task intervals
	updateAgeOnGet: false,
});

// AUTH FAIL GC ---------------------------------------------------------------
// Steps: periodically drop stale auth-miss entries and cap map size so repeated abuse can’t grow memory unbounded.
setInterval(() => {
	const now = Date.now();
	for (const [k, t] of authFails) if (now - t > AUTH_FAIL_TTL) authFails.delete(k);
	if (authFails.size >= AUTH_FAIL_MAX)
		Array.from(authFails.keys())
			.slice(0, 100)
			.forEach(k => authFails.delete(k));
}, 300000);

// AUTH HANDLER -----------------------------------------------------------------
// Verifies the caller’s role for a chat action:
// - reads cached role+last pointer from redis hash
// - falls back to SQL on cache miss (rate-limited by authFails map)
// Returns [roleOrNull, lastSeenMessageId] so callers can both authorize and clamp visibility.
// Steps: attempt redis role lookup first; if missing and not rate-limited, fetch from SQL and backfill redis; return role only if allowed for the requested mode.
async function authorizeRole({ chatID, mode = 'adminRoles', userID }: any) {
	const k = `${userID}_${chatID}`;
	let [r, last] = (await redis.hget(REDIS_KEYS.userChatRoles, k))?.split('_') || [null, null];

	if (!r && Date.now() - (authFails.get(k) || 0) > AUTH_FAIL_TTL) {
		const con = await Sql.getConnection();
		try {
			const [rows] = await con.execute(`SELECT role, last FROM chat_members WHERE chat=? AND id=?`, [chatID, userID]);
			if (rows[0]) ({ role: r, last } = rows[0]);
		} finally {
			con.release();
		}

		if (r)
			await setRolesAndLasts({ members: [{ id: userID, role: r, lastMessID: last }], chatID }),
				redis.expire(REDIS_KEYS.userChatRoles, ROLES_TTL).catch(err => logger.error('authorizeRole.expire_failed', { error: err }));
		else authFails.set(k, Date.now());
	}
	return [r && necessaryRoles[mode]?.has(r) ? r : null, last];
}

// STATE UPDATER ----------------------------------------------------------------
// Syncs chat membership/roles to redis:
// - USER_CHAT_ROLES hash for fast auth (role + optional last pointer)
// - CHAT_MEMBERS set for member enumeration
// - lastMembChangeAt for incremental member sync
// Steps: stage role hash updates and membership set updates into one multi, optionally bump membSync timestamp, exec once, then invalidate local membersCache.
async function setRolesAndLasts({ members, memberIDs, chatID, lastAllowedMess, role, addToMembers, skipRolesUpdate, delFromMembers, setMembChange }: any) {
	const t = redis.multi(),
		key = `${REDIS_KEYS.chatMembers}:${chatID}`,
		vals = [];
	let ops = false;

	const items = members || (memberIDs || []).map(id => ({ id, role, lastMessID: lastAllowedMess }));
	if (items.length && (!skipRolesUpdate || members)) {
		items.forEach(m => vals.push(`${m.id}_${chatID}`, `${m.role}${m.lastMessID != null ? `_${m.lastMessID}` : ''}`));
		t.hset(REDIS_KEYS.userChatRoles, ...vals);
		ops = true;
	}

	if (setMembChange) t.hset(REDIS_KEYS.lastMembChangeAt, chatID, typeof setMembChange === 'number' ? setMembChange : Date.now()), (ops = true);
	if (addToMembers || (delFromMembers && items.length)) {
		t[addToMembers ? 'sadd' : 'srem'](key, ...items.map(m => m.id));
		if (addToMembers) t.expire(key, MEMBERS_TTL);
		ops = true;
	}
	if (ops) {
		const res = await t.exec();
		if (!res || res.some(([err]) => err)) {
			const errors = res
				.filter(([err]) => err)
				.map(([err]) => err.message)
				.join(', ');
			throw new Error(`Redis transaction failed: ${errors}`);
		}
		// INVALIDATE CACHE: Ensure subsequent reads fetch fresh data from Redis
		if (addToMembers || delFromMembers) membersCache.delete(chatID);
	}
	return items.map(m => m.id);
}

// FETCH HANDLERS --------------------------------------------------------------

// GET MEMBERS ------------------------------------------------------------------
// Retrieves member lists from redis (preferred) or SQL:
// - redis provides fast ID lists for active membership
// - SQL provides canonical member rows and supports incremental sync via membSync timestamp
// Steps: prefer in-memory IDs cache, then redis smembers, then SQL fetch rows (optionally filtered by ids + membSync), then backfill redis roles/members on cold start.
async function getMembers({ memberIDs = [], chatID, membSync: prev, mode = 'getMembers', IDsOnly, includeArchived, con }: any) {
	if (!con) throw new Error('Database connection required');
	const key = `${REDIS_KEYS.chatMembers}:${chatID}`;

	// CACHE CHECK: Use in-memory cache for IDs if available and no specific IDs requested
	let ids = memberIDs;
	if (!ids.length) {
		const cachedIDs = membersCache.get(chatID);
		if (cachedIDs) ids = cachedIDs;
		else {
			ids = (await redis.smembers(key)) || [];
			if (ids.length) {
				membersCache.set(chatID, ids);
				redis.expire(key, MEMBERS_TTL).catch(err => logger.error('getMembers.expire_failed', { error: err }));
			}
		}
	}

	if (IDsOnly && ids.length && !includeArchived) return ids;

	const params = [chatID],
		q = `SELECT u.id${
			!IDsOnly ? ', u.first, u.last, u.imgVers, cm.role, cm.punish, cm.until, cm.who, cm.mess, cm.flag, cm.last as lastMessID, cm.seen as seenId' : ''
		} FROM users u JOIN chat_members cm ON u.id = cm.id WHERE cm.chat = ? ${mode === 'getMembers' && !memberIDs.length ? `AND cm.flag != 'del' ${includeArchived ? '' : 'AND archived = 0'}` : ''}`;
	const [rows] = await con.execute(q + (ids.length ? ` AND cm.id IN (${ids.map(() => '?').join(',')})` : '') + (prev ? ' AND cm.changed >= FROM_UNIXTIME(?/1000)' : ''), [
		...params,
		...ids,
		...(prev ? [prev] : []),
	]);

	if (IDsOnly && rows.length) return rows.map(r => r.id);
	if (mode === 'getMembers' && !ids.length) await setRolesAndLasts({ members: rows, chatID, addToMembers: true });
	return { members: rows, ...(prev && { membSync: await redis.hget(REDIS_KEYS.lastMembChangeAt, chatID) }) };
}

// GET MESSAGES -----------------------------------------------------------------
// Fetches message history with cursor-based pagination.
// Supports bounded range fetch and hides deleted content outside explicit range requests.
// Steps: normalize numeric params, build the appropriate id clause (range/greater/less), then fetch newest-first with a small page size to cap payload.
async function getMessages({ firstID, lastID = 0, cursor, chatID, last, con }: any) {
	[firstID, lastID, cursor, last] = [firstID, lastID, cursor, last].map(v => {
		const numVal = Number(v);
		return numVal && Number.isFinite(numVal) && numVal > 0 ? numVal : v === undefined ? undefined : 0;
	});
	const cur = cursor || last ? Math.min(cursor || Infinity, last || Infinity) : null;
	const idsClauseSrc =
		firstID && lastID
			? { sql: `BETWEEN ? AND ?`, params: [Math.min(firstID, lastID), Math.max(firstID, lastID)] }
			: firstID
			? { sql: `> ?`, params: [firstID] }
			: lastID
			? { sql: `< ?`, params: [lastID] }
			: { sql: null, params: [] };

	const q = `SELECT m.id, ${!firstID && !lastID ? 'm.content' : `CASE WHEN m.flag != 'del' THEN m.content ELSE NULL END AS content`}, m.user, m.attach, m.created FROM messages m WHERE m.chat = ? ${
		cur ? 'AND m.id < ?' : ''
	} ${idsClauseSrc.sql ? `AND m.flag = IF(m.id ${idsClauseSrc.sql}, "del", "ok")` : 'AND m.flag = "ok"'} ORDER BY m.id DESC LIMIT 20`;
	return { messages: (await con.execute(q, [chatID, ...(cur ? [cur] : []), ...idsClauseSrc.params]))[0] };
}

export { authorizeRole, getMembers, getMessages, setRolesAndLasts, needsAuth };
