import { Sql } from '../../systems/systems.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { LRUCache } from 'lru-cache';

const logger = getLogger('ChatHelpers');

// ROLE DEFINITIONS ------------------------------------------------------------
// Steps: define role sets once so authorization checks are cheap and consistent across HTTP + socket entry points.
const ROLES_MAP = {
	all: new Set(['member', 'priv', 'guard', 'admin', 'VIP', 'gagged',  'spect',]),
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

const needsAuth: Set<string> = new Set(Object.keys(necessaryRoles));
let redis: any;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Injects the shared redis client so chat helper functions can run without importing Redis singleton.
// This keeps helpers usable from both HTTP modules and socket handlers.
// Steps: accept the shared redis instance once at startup; callers must ensure the client is ready before chat traffic begins.
export const setChatHelpersRedisClient = (r: any): void => {
	redis = r;
};

// CACHE & TTL ------------------------------------------------------------------
// TTLs keep redis keys fresh and prevent unbounded growth.
// authFails is an in-memory rate limiter for repeated missing-role lookups (DDoS containment).
// membersCache provides micro-caching for member IDs to reduce Redis roundtrips during high activity.
const [MEMBERS_TTL, ROLES_TTL, AUTH_FAIL_TTL, AUTH_FAIL_MAX]: [number, number, number, number] = [604800, 86400, 60000, 10000];
const authFails: Map<string, number> = new Map<string, number>();
const membersCache: LRUCache<string, string[]> = new LRUCache<string, string[]>({
	max: 1000, // Track up to 1000 active chats
	ttl: 5 * 60 * 1000, // 5 minute TTL matching task intervals
	updateAgeOnGet: false,
});

// AUTH FAIL GC ---------------------------------------------------------------
// Steps: periodically drop stale auth-miss entries and cap map size so repeated abuse can’t grow memory unbounded.
// TIMER SINGLETON --------------------------------------------------------------
// Steps: prevent duplicate intervals in dev reloads by storing the timer on global, and unref so it never blocks shutdown.
const AUTH_FAIL_GC_INTERVAL_MS = 300000;
const AUTH_FAIL_GC_TIMER_KEY = '__chat_helpers_auth_fail_gc_timer__';
const startAuthFailGarbageCollector = (): void => {
	if ((global as any)[AUTH_FAIL_GC_TIMER_KEY]) return;
	(global as any)[AUTH_FAIL_GC_TIMER_KEY] = setInterval(() => {
		const now: number = Date.now();
		for (const [k, t] of authFails) if (now - t > AUTH_FAIL_TTL) authFails.delete(k);
		if (authFails.size >= AUTH_FAIL_MAX)
			Array.from(authFails.keys())
				.slice(0, 100)
				.forEach(k => authFails.delete(k));
	}, AUTH_FAIL_GC_INTERVAL_MS);
	try {
		((global as any)[AUTH_FAIL_GC_TIMER_KEY] as any).unref?.();
	} catch {}
};
startAuthFailGarbageCollector();

export interface AuthorizeRoleProps {
	chatID: string | number;
	mode?: keyof typeof necessaryRoles;
	userID: string | number;
	con?: any;
}

// AUTH HANDLER -----------------------------------------------------------------
// Verifies the caller's role for a chat action:
// - reads cached role+last pointer from redis hash
// - falls back to SQL on cache miss (rate-limited by authFails map)
// Returns [roleOrNull, lastSeenMessageId] so callers can both authorize and clamp visibility.
// Steps: attempt redis role lookup first; if missing and not rate-limited, fetch from SQL and backfill redis; return role only if allowed for the requested mode.
// CONNECTION REUSE ---------------------------------------------------------
// Steps: accept optional connection parameter to avoid opening a second connection when one is already available; only open new connection if none provided (backward compatibility).
async function authorizeRole({ chatID, mode = 'adminRoles', userID, con }: AuthorizeRoleProps): Promise<[string | null, string | number | null]> {
	const k: string = `${userID}_${chatID}`;
	let [r, last]: [string | null, string | number | null] = (await redis.hget(REDIS_KEYS.userChatRoles, k))?.split('_') || [null, null];

	if (!r && Date.now() - (authFails.get(k) || 0) > AUTH_FAIL_TTL) {
		let shouldRelease: boolean = false;
		if (!con) (con = await Sql.getConnection()), (shouldRelease = true);

		try {
			const [rows]: [any[], any] = await con.execute(`SELECT role, last FROM chat_members WHERE chat=? AND id=?`, [chatID, userID]);
			if (rows[0]) ({ role: r, last } = rows[0]);
		} finally {
			if (shouldRelease) con.release();
		}

		if (r)
			await setRolesAndLasts({ members: [{ id: userID, role: r, lastMessID: last }], chatID }),
				redis.expire(REDIS_KEYS.userChatRoles, ROLES_TTL).catch(err => logger.error('authorizeRole.expire_failed', { error: err }));
		else authFails.set(k, Date.now());
	}
	return [r && necessaryRoles[mode]?.has(r) ? r : null, last];
}

interface SetRolesAndLastsProps {
	members?: any[];
	memberIDs?: (string | number)[];
	chatID: string | number;
	lastAllowedMess?: string | number;
	role?: string;
	addToMembers?: boolean;
	skipRolesUpdate?: boolean;
	delFromMembers?: boolean;
	setMembChange?: boolean | number;
}

// STATE UPDATER ----------------------------------------------------------------
// Syncs chat membership/roles to redis:
// - USER_CHAT_ROLES hash for fast auth (role + optional last pointer)
// - CHAT_MEMBERS set for member enumeration
// - lastMembChangeAt for incremental member sync
// Steps: stage role hash updates and membership set updates into one multi, optionally bump membSync timestamp, exec once, then invalidate local membersCache.
async function setRolesAndLasts({
	members,
	memberIDs,
	chatID,
	lastAllowedMess,
	role,
	addToMembers,
	skipRolesUpdate,
	delFromMembers,
	setMembChange,
}: SetRolesAndLastsProps): Promise<(string | number)[]> {
	const t: any = redis.multi(),
		key: string = `${REDIS_KEYS.chatMembers}:${chatID}`,
		vals: any[] = [];
	let ops: boolean = false;

	const items: any[] = members || (memberIDs || []).map(id => ({ id, role, lastMessID: lastAllowedMess }));
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
		const res: any[] | null = await t.exec();
		// PARTIAL FAILURE HANDLING ---
		// Steps: log errors but don't throw to avoid leaving caches in inconsistent state; invalidate cache regardless so next read refetches from source.
		if (!res || res.some(([err]) => err)) {
			const errors: string = (res || [])
				.filter(([err]) => err)
				.map(([err]) => err?.message || 'unknown')
				.join(', ');
			logger.error('setRolesAndLasts.partial_failure', { errors, chatID, memberCount: items.length });
		}
		// INVALIDATE CACHE: Ensure subsequent reads fetch fresh data from Redis regardless of partial failure
		if (addToMembers || delFromMembers) membersCache.delete(String(chatID));
	}
	return items.map(m => m.id);
}

interface GetMembersProps {
	memberIDs?: (string | number)[];
	chatID: string | number;
	membSync?: number;
	mode?: string;
	IDsOnly?: boolean;
	includeArchived?: boolean;
	con: any;
}

// GET MEMBERS ------------------------------------------------------------------
// Retrieves member lists from redis (preferred) or SQL:
// - redis provides fast ID lists for active membership
// - SQL provides canonical member rows and supports incremental sync via membSync timestamp
// Steps: prefer in-memory IDs cache, then redis smembers, then SQL fetch rows (optionally filtered by ids + membSync), then backfill redis roles/members on cold start.
async function getMembers({ memberIDs = [], chatID, membSync: prev, mode = 'getMembers', IDsOnly, includeArchived, con }: GetMembersProps): Promise<any> {
	if (!con) throw new Error('Database connection required');
	const key: string = `${REDIS_KEYS.chatMembers}:${chatID}`;

	// CACHE CHECK: Use in-memory cache for IDs if available and no specific IDs requested
	let ids: (string | number)[] = memberIDs;
	if (!ids.length) {
		const cachedIDs: string[] | undefined = membersCache.get(String(chatID));
		if (cachedIDs) ids = cachedIDs;
		else {
			ids = (await redis.smembers(key)) || [];
			if (ids.length) {
				membersCache.set(String(chatID), ids as string[]);
				redis.expire(key, MEMBERS_TTL).catch(err => logger.error('getMembers.expire_failed', { error: err }));
			}
		}
	}

	if (IDsOnly && ids.length && !includeArchived) return ids;

	const params: any[] = [chatID],
		q: string = `SELECT u.id${
			!IDsOnly ? ', u.first, u.last, u.imgVers, cm.role, cm.punish, cm.until, cm.who, cm.mess, cm.flag, cm.last as lastMessID, cm.seen as seenId' : ''
		} FROM users u JOIN chat_members cm ON u.id = cm.id WHERE cm.chat = ? ${mode === 'getMembers' && !memberIDs.length ? `AND cm.flag != 'del' ${includeArchived ? '' : 'AND archived = 0'}` : ''}`;
	const [rows]: [any[], any] = await con.execute(q + (ids.length ? ` AND cm.id IN (${ids.map(() => '?').join(',')})` : '') + (prev ? ' AND cm.changed >= FROM_UNIXTIME(?/1000)' : ''), [
		...params,
		...ids,
		...(prev ? [prev] : []),
	]);

	if (IDsOnly && rows.length) return rows.map(r => r.id);
	if (mode === 'getMembers' && !ids.length && rows.length) await setRolesAndLasts({ members: rows, chatID, addToMembers: true });
	return { members: rows, ...(prev && { membSync: await redis.hget(REDIS_KEYS.lastMembChangeAt, chatID) }) };
}

interface GetMessagesProps {
	firstID?: string | number;
	lastID?: string | number;
	cursor?: string | number;
	chatID: string | number;
	last?: string | number;
	userID?: string | number;
	res?: any;
	con: any;
}

// GET MESSAGES -----------------------------------------------------------------
// Fetches message history with cursor-based pagination.
// Supports bounded range fetch and hides deleted content outside explicit range requests.
// Steps: normalize numeric params, build the appropriate id clause (range/greater/less), then fetch newest-first with a small page size to cap payload.
async function getMessages({ firstID, lastID = 0, cursor, chatID, last, con }: GetMessagesProps): Promise<{ messages: any[] }> {
	const normalizedParams: (number | undefined)[] = [firstID, lastID, cursor, last].map(v => {
		const numVal: number = Number(v);
		return numVal && Number.isFinite(numVal) && numVal > 0 ? numVal : v === undefined ? undefined : 0;
	});
	let [fID, lID, curs, lst]: (number | undefined)[] = normalizedParams;

	const cur: number | null = curs || lst ? Math.min(curs || Infinity, lst || Infinity) : null;
	const idsClauseSrc: { sql: string | null; params: any[] } =
		fID && lID
			? { sql: `BETWEEN ? AND ?`, params: [Math.min(fID, lID), Math.max(fID, lID)] }
			: fID
			? { sql: `> ?`, params: [fID] }
			: lID
			? { sql: `< ?`, params: [lID] }
			: { sql: null, params: [] };

	const q: string = `SELECT m.id, ${!fID && !lID ? 'm.content' : `CASE WHEN m.flag != 'del' THEN m.content ELSE NULL END AS content`}, m.user, m.attach, m.created FROM messages m WHERE m.chat = ? ${
		cur ? 'AND m.id < ?' : ''
	} ${idsClauseSrc.sql ? `AND m.flag = IF(m.id ${idsClauseSrc.sql}, "del", "ok")` : 'AND m.flag = "ok"'} ORDER BY m.id DESC LIMIT 20`;
	const [rows]: [any[], any] = await con.execute(q, [chatID, ...(cur ? [cur] : []), ...idsClauseSrc.params]);
	return { messages: rows };
}

export { authorizeRole, getMembers, getMessages, setRolesAndLasts, needsAuth };
