import { delFalsy } from '../../shared/utilities.ts';
import { Sql, Catcher } from '../systems/systems.ts';
import { REDIS_KEYS } from '../../shared/constants.ts';
import { generateIDString } from '../utilities/idGenerator.ts';
import { broadcastChatChanged, broadcastNewChat, broadcastMembersChanged, manageUsersInChatRoom, endChat as endSocket } from '../systems/socket/chatHandlers.ts';
import { messSeen, fetchSeenUpdates, setSeenRedisClient, writeSeenEntriesToCache } from './chat/seenSync.ts';
import { quickQueryHandlers } from './chat/quickQueries.ts';
import { messageHandlers } from './chat/messageHandlers.ts';
import { authorizeRole, getMembers, getMessages, setRolesAndLasts, needsAuth, setChatHelpersRedisClient } from './chat/chatHelpers.ts';

interface ChatMemberInput {
	id: string | number;
	role?: string;
	flag?: string;
}

interface ChatRequest {
	body: {
		mode: string;
		members?: ChatMemberInput[];
		type?: 'private' | 'group' | 'free' | 'VIP';
		name?: string;
		content?: string;
		similarChatsDenied?: boolean;
		userID: string | number;
		chatID?: string | number;
		chatIDs?: (string | number)[];
		cursor?: string | number;
		getNewest?: boolean;
		firstID?: string | number;
		lastID?: string | number;
		last?: string | number;
		getPunInfo?: boolean;
		membSync?: number;
		seenSync?: number;
		message?: any;
		socket?: any;
		role?: string;
	};
}

let redis: any;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Injects shared redis and forwards it to chat submodules that maintain their own caches.
export const ioRedisSetter = (redisInstance: any) => {
	redis = redisInstance;
	setSeenRedisClient(redisInstance);
	setChatHelpersRedisClient(redisInstance);
};
// ROLE ALLOWLIST ---------------------------------------------------------------
// Steps: define all roles we allow to enter DB/cache state; prevents accidental persistence of typo roles.
const NEW_ROLES = new Set(['member', 'priv', 'guard', 'admin', 'VIP', 'spect']);
// DISPATCH MAP -----------------------------------------------------------------
// Steps: merge submodule handlers into one stable map so Chat can dispatch by mode without dynamic imports.
const extHandlers: any = { ...messageHandlers, ...quickQueryHandlers, messSeen };

// HELPERS ---------------------------------------------------------------------

// GET LEADERS ------------------------------------------------------------------
// Loads chat type and leadership roles (admin/VIP) from SQL:
// - used to validate setupChat permission and enforce VIP constraints
// - returns arrays of user IDs for fast membership checks
// Steps: select chat type and only leadership roles, then split into arrays for fast checks in setup/end logic.
const getLeaders = async (connection: any, id: string | number) => {
	const [result]: [any[], any] = await connection.execute(
		`SELECT c.type, cm.id, cm.role FROM chats c LEFT JOIN chat_members cm ON cm.chat = c.id AND cm.flag = 'ok' AND cm.role IN ('admin', 'VIP') WHERE c.id = ?`,
		[id]
	);
	return { type: result[0]?.type, admins: result.filter(member => member.role === 'admin').map(member => member.id), vips: result.filter(member => member.role === 'VIP').map(member => member.id) };
};

// TRANSACTION WRAPPER ---------------------------------------------------------
// Wraps a function in a SQL transaction (commit/rollback)
// CHAT TRANSACTION -------------------------------------------------------------
// Ensures chat mutations are atomic and rollback on any failure.
// Steps: beginTransaction, run transactionFunction, commit on success, rollback on error, then rethrow so caller can map to Catcher.
export const runChatTransaction = async (connection: any, transactionFunction: () => Promise<any>) => {
	try {
		await connection.beginTransaction();
		const result = await transactionFunction();
		await connection.commit();
		return result;
	} catch (error) {
		await connection.rollback();
		throw error;
	}
};

const chatTransaction = runChatTransaction; // Alias for internal use

// HANDLERS --------------------------------------------------------------------

/** ----------------------------------------------------------------------------
 * CREATE NEW CHAT
 * Validates input, members, and reuse logic for private chats.
 * Inserts new chat/members into DB, posts initial message, and broadcasts creation.
 *
 * @param {Object} members - Array of member objects {id, role}
 * @param {string} type - 'private' | 'group' | 'free' | 'VIP'
 * -------------------------------------------------------------------------- */
async function createChat({ members: membersInput, type = 'private', name, content, similarChatsDenied, userID, con: connection }: any) {
	const members: ChatMemberInput[] = membersInput.map((member: any) => ({
		...member,
		id: String(member.id || '').trim(),
		role: type === 'private' ? 'priv' : type !== 'free' && String(member.id) === String(userID) && (!member.role || member.role === 'member') ? 'admin' : String(member.role || 'member').trim(),
	}));
	const memberIDs = members.map(member => member.id);

	// VALIDATION ---
	// 1. Must have members, valid IDs/roles.
	// 2. Private: max 2 members.
	// 3. Group/VIP: must have name and at least one admin/VIP.
	// 4. Creator must be a member.
	if (
		!members.length ||
		members.some(member => !member.id || String(member.id).length > 20 || member.flag !== 'ok' || !NEW_ROLES.has(member.role!) || (type !== 'private' && member.role === 'priv')) ||
		(type === 'private' && members.length > 2) ||
		(type !== 'private' && (!name?.trim() || (type !== 'free' && !members.some(member => member.role === 'admin') && !members.some(member => member.role === 'VIP')))) ||
		(type === 'VIP' && !members.some(member => member.role === 'VIP')) ||
		!memberIDs.includes(userID) ||
		new Set(memberIDs).size !== members.length ||
		members.length > 20 ||
		!content?.trim()
	)
		throw new Error('badRequest');

	// CHECK EXISTING (SIMILAR) CHATS ---
	// If similarChatsDenied is false, look for existing chats with same members to avoid duplicates.
	// Steps: run a “same members” query, return similar chats for confirmation (group), or reuse existing private chat and append message when safe.
	if (!similarChatsDenied) {
		const query =
			type === 'private'
				? `SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat = c.id WHERE c.type = 'private' GROUP BY c.id HAVING COUNT(*) = ? AND SUM(cm.id IN (${memberIDs.map(
						() => '?'
				  )})) = ? LIMIT 1`
				: `WITH dc AS (SELECT cm.chat as id FROM chat_members cm WHERE cm.id = ? AND cm.punish NOT IN ('ban','gag') AND EXISTS (SELECT 1 FROM chat_members cm2 WHERE cm2.chat = cm.chat AND cm2.id IN (${memberIDs.map(
						() => '?'
				  )}) GROUP BY cm2.chat HAVING COUNT(DISTINCT cm2.id) = ${members.length})) SELECT dc.id FROM dc LEFT JOIN chat_members cm ON dc.id = cm.chat AND cm.id = ? LIMIT 10`;
		const [similarChats]: [any[], any] = await connection.execute(query, type === 'private' ? [memberIDs.length, ...memberIDs, memberIDs.length] : [userID, ...memberIDs, userID]);

		if (similarChats.length) {
			const { chats } = await getChats({ mode: 'getChats', userID, chatIDs: similarChats.map(chat => chat.id), con: connection });
			// If group/VIP, just return similar chats for user confirmation.
			if (type !== 'private') return { similarChats: chats };

			// For private, automatically reuse if not blocked by other party.
			const { punish, who, id, archived } = chats[0] || {};
			if (punish === 'block' && String(who) !== String(userID)) return { similarChats: chats };

			// Post new message to existing chat.
			const [{ messages }, { messID, didJoinRoom }]: [any, any] = await Promise.all([
				getMessages({ chatID: id, userID, con: connection }),
				messageHandlers.postMessage({ message: { content }, chatID: id, userID, con: connection, redis }),
			]);

			// Unarchive/Unblock if needed.
			await chatTransaction(connection, async () => {
				if (archived) await connection.execute(`UPDATE chat_members SET archived = 0 WHERE chat = ? AND id = ?`, [id, userID]), (chats[0].archived = false);
				if (String(who) === String(userID)) await connection.execute(`UPDATE chat_members SET punish = NULL, who = NULL WHERE chat = ?`, [id]), (chats[0].punish = null);
			});
			return { messID, didJoinRoom, similarChats: chats, messages: [...messages, { id: messID, user: userID, content, created: Date.now() }] };
		}
	}

	// CREATE NEW CHAT ---
	// Steps: generate Snowflake ID, insert chat row, insert members, sync redis role/member caches, post first message, set seen pointer, update last_mess, then broadcast.
	const now = Date.now();
	let messID: any, didJoinRoom: any;
	const chatID = generateIDString();

	await chatTransaction(connection, async () => {
		await connection.execute(`INSERT INTO chats (id, name, type) VALUES (?, ?, ?)`, [chatID, name || null, type]);
		await connection.execute(
			`INSERT INTO chat_members (chat, id, role) VALUES ${members.map(() => '(?, ?, ?)').join(', ')}`,
			members.flatMap(member => [chatID, member.id, member.role])
		);
	});

	// Initialize Redis cache state for members & post first message.
	await setRolesAndLasts({ members: members, chatID, addToMembers: true, setMembChange: now });
	({ messID, didJoinRoom } = await messageHandlers.postMessage({ message: { content }, chatID, userID, skipBroadcast: true, con: connection, redis }));
	await Promise.all([writeSeenEntriesToCache(chatID, [{ id: userID, seenId: messID }]), connection.execute(`UPDATE chats SET last_mess = ? WHERE id = ?`, [messID, chatID])]);

	if (didJoinRoom)
		broadcastNewChat({
			chatObj: { id: chatID, name, members: members, membSync: now, messages: [{ id: messID, user: userID, content, created: Date.now() }], cursors: 'gotAll', flag: 'ok', type },
		});
	return { chatID, messID, didJoinRoom, membSync: now, seenSync: now };
}

/** ----------------------------------------------------------------------------
 * SETUP CHAT
 * Adds/removes members, changes roles, updates chat name/type.
 * Validates permissions and enforces type transitions (e.g. Free -> Group).
 * -------------------------------------------------------------------------- */
async function setupChat({ members: rawMembers, type, name, chatID, socket, role, con: connection }: any) {
	// 1) VALIDATE PERMISSIONS & TYPE TRANSITIONS
	// Steps: load current chat type/leaders, reject illegal transitions and non-leader edits (especially VIP constraints).
	const { type: currentType, admins, vips } = await getLeaders(connection, chatID);
	if (
		!currentType ||
		currentType === 'private' ||
		type === 'private' ||
		(type === 'free' &&
			currentType !== 'free' &&
			!rawMembers.some((member: any) => member.role === 'admin') &&
			!admins.some((id: any) => rawMembers.some((member: any) => member.id === id && member.role !== 'admin'))) || // Downgrade to free must remove admins
		(type === 'group' && !['group', 'VIP'].includes(currentType)) ||
		(type === 'VIP' && currentType !== 'VIP') ||
		(currentType === 'VIP' && role !== 'VIP' && rawMembers.some((m: any) => vips.includes(m.id))) // Non-VIPs cannot touch VIP members
	)
		throw new Error('badRequest');

	const [members, deletedMembers, newMembers]: [any[], any[], any[]] = [[], [], []];
	const currentMemberIds: (string | number)[] = await getMembers({ chatID, mode: 'getMembers', IDsOnly: true, includeArchived: true, con: connection });

	// 2) CLASSIFY MEMBER CHANGES
	// Steps: partition rawMembers into updated / deleted / new based on currentMemberIds.
	rawMembers.forEach((member: any) => {
		if (!member.id || !NEW_ROLES.has(member.role) || !['del', 'ok'].includes(member.flag) || (member.flag === 'del' && member.role !== 'spect') || member.role === 'priv')
			throw new Error('badRequest');
		(currentMemberIds.includes(member.id) ? (member.flag === 'del' ? deletedMembers : members) : newMembers).push(member);
	});

	// 3) VALIDATE CHAT LOGIC (e.g. Groups must have admin)
	// Steps: enforce per-type invariants so DB state cannot represent an invalid chat configuration.
	const checks: Record<string, () => boolean> = {
		free: () => members.some(member => member.role === 'member') && !members.some(member => ['VIP', 'admin'].includes(member.role)),
		group: () =>
			!members.some(member => member.role === 'VIP') &&
			(members.some(member => member.role === 'admin') || admins.some((id: any) => members.some(member => member.id === id && member.role !== 'admin'))),
		VIP: () => {
			const vipMember = members.find(member => member.role === 'VIP' && member.id !== vips[0]);
			return !vipMember || !vips[0] || members.some(member => member.id === vips[0] && member.role !== 'VIP');
		},
	};

	if (
		!rawMembers.length ||
		members.length + newMembers.length - deletedMembers.length > 20 ||
		new Set(members.map(member => member.id)).size !== members.length ||
		!checks[type as string]() ||
		(!name && type !== 'private')
	)
		throw new Error('badRequest');

	// 4) EXECUTE DB UPDATES
	// Steps: upsert members, soft-delete removed members, update chats table fields, all inside a transaction.
	const now = Date.now(),
		querySource = Object.entries({ name, type }).filter(([, value]) => value),
		result = await chatTransaction(connection, async () => {
			const output: { updated: any[]; deleted: any[]; meta: boolean } = { updated: [], deleted: [], meta: false };

			// UPSERT MEMBERS (Update existing or Insert new)
			if (members.length || newMembers.length) {
				const upsert = [...members, ...newMembers];
				await connection.execute(
					`INSERT INTO chat_members (chat, id, role) VALUES ${upsert
						.map(() => '(?, ?, ?)')
						.join(', ')} ON DUPLICATE KEY UPDATE changed = NOW(), role = VALUES(role), flag = CASE WHEN flag IN ('req','ref', 'del') THEN 'ok' ELSE flag END`,
					upsert.flatMap(user => [chatID, user.id, user.role])
				);
				output.updated = upsert;
			}
			// DELETE MEMBERS (Soft delete -> flag='del', role='spect')
			if (deletedMembers.length) {
				const placeholders = deletedMembers.map(() => '?').join(',');
				await connection.execute(
					`UPDATE chat_members SET changed = NOW(), flag = 'del', prev_flag = NULL, role = 'spect', last = COALESCE(last, (SELECT last_mess FROM chats WHERE id = ?)) WHERE chat = ? AND id IN (${placeholders}) AND flag != 'del'`,
					[chatID, chatID, ...deletedMembers.map(member => member.id)]
				);
				const [rows]: [any[], any] = await connection.execute(`SELECT id, last as lastMessID FROM chat_members WHERE chat = ? AND id IN (${placeholders})`, [
					chatID,
					...deletedMembers.map(member => member.id),
				]);
				output.deleted = rows.map(row => ({
					...row,
					role: 'spect',
				}));
			}
			// UPDATE CHAT METADATA
			if (querySource.length)
				await connection.execute(`UPDATE chats SET ${querySource.map(([key]) => `${key} = ?`).join(', ')}, changed = NOW() WHERE id = ?`, [...querySource.map(([, value]) => value), chatID]);
			return { ...output, meta: !!querySource.length };
		});

	// 5) SYNC REDIS & BROADCAST
	// Steps: update redis membership/roles, update socket room membership, then broadcast the change events.
	if (!result.meta && querySource.length)
		await connection.execute(`UPDATE chats SET ${querySource.map(([key]) => `${key} = ?`).join(', ')}, changed = NOW() WHERE id = ?`, [...querySource.map(([, value]) => value), chatID]);
	if (result.updated.length)
		await setRolesAndLasts({ members: result.updated, chatID, addToMembers: true, setMembChange: now }),
			newMembers.length && (await manageUsersInChatRoom({ chatID, userIDs: newMembers.map((member: any) => member.id), mode: 'add' }));
	if (result.deleted.length)
		await setRolesAndLasts({ chatID, members: result.deleted, delFromMembers: true, setMembChange: now }),
			await manageUsersInChatRoom({ chatID, userIDs: result.deleted.map((member: any) => member.id), mode: 'rem' });
	broadcastChatChanged({ socket, chatObj: { id: chatID, type, name, members: [...members, ...newMembers], membSync: now } });
}

/** ----------------------------------------------------------------------------
 * GET CHATS
 * Fetches user chats with filtering (active, archived, hidden).
 * Supports cursor-based pagination and optimizes query to avoid full scans.
 * -------------------------------------------------------------------------- */
async function getChats({ mode, cursor = null, getNewest = false, userID, chatID = null, chatIDs = [], con: connection }: any) {
	// GET CHATS QUERY PLAN ---------------------------------------------------
	// Steps: compute flag condition by mode, apply cursor bounds, optionally filter by ids, then query via a CTE to keep joins bounded.
	if (!userID || (cursor && isNaN(parseInt(cursor)))) throw new Error('badRequest');

	// BUILD QUERY CONDITIONS
	const [flagCondition, cursorCondition, idsCondition]: [string, [string, any[]], [string, any[]]] = [
		chatID || chatIDs.length
			? "cm.flag = 'ok'"
			: mode === 'getChats'
			? "((cm.flag = 'ok' AND cm.archived = 0) OR (cm.hidden = 1 AND c.last_mess > cm.seen))"
			: `cm.flag = '${mode === 'getInactiveChats' ? 'del' : 'ok'}' ${mode === 'getHiddenChats' ? 'AND cm.hidden = 1' : ''} ${mode === 'getArchivedChats' ? 'AND cm.archived = 1' : ''}`,
		getNewest ? ['AND c.last_mess > ?', [cursor]] : ['AND (? IS NULL OR c.last_mess < ?)', [cursor || null, cursor || null]],
		chatID ? ['AND c.id = ?', [chatID]] : chatIDs.length ? [`AND c.id IN (${chatIDs.map(() => '?').join(',')})`, chatIDs] : ['', []],
	];

	// EXECUTE COMPLEX JOIN
	// 1. CTE (tempChats): Get relevant chat IDs first (optimization).
	// 2. Main Query: Join back to messages/members to get preview content and other party details.
	const [chats]: [any[], any] = await connection.execute(
		`WITH tc AS (SELECT c.id, c.last_mess FROM chats c JOIN chat_members cm ON c.id = cm.chat AND cm.id = ? WHERE ${flagCondition} ${idsCondition[0]} ${
			cursorCondition[0]
		} ORDER BY c.last_mess DESC LIMIT ${chatID ? 1 : 20})
			SELECT c.id, c.ended, cm.flag, cm.hidden, cm.archived, cm.seen as seenId, c.name, c.type, c.last_mess as lastMessID, LEFT(m.content, 100) as content, m.attach, m.created, cm.role, m.user, cm.punish, cm.who, cm.until, cm.muted,
			CASE WHEN c.type = 'private' THEN CONCAT(uo.id,':',uo.first,':',uo.last,':',uo.imgVers,':',COALESCE(cmo.seen,'')) WHEN m.user IS NOT NULL THEN CONCAT(ua.id,':',ua.first,':',ua.last,':',ua.imgVers,':',COALESCE(cma.seen,'')) END as chatMember
			FROM tc JOIN chats c ON c.id = tc.id JOIN chat_members cm ON c.id = cm.chat AND cm.id = ? LEFT JOIN messages m ON c.last_mess = m.id
			LEFT JOIN chat_members cmo ON c.id = cmo.chat AND cmo.id != ? AND c.type = 'private' LEFT JOIN users uo ON cmo.id = uo.id
			LEFT JOIN chat_members cma ON c.id = cma.chat AND cma.id = m.user LEFT JOIN users ua ON m.user = ua.id ORDER BY tc.last_mess DESC`,
		[userID, ...idsCondition[1], ...cursorCondition[1], userID, userID]
	);
	// SYNC USER SUMMARY (Clear unread/archived counts if fetching first page)
	if (!cursor && !chatIDs.length && !chatID) {
		const key = `${REDIS_KEYS.userSummary}:${userID}`;
		if (mode === 'getChats' && (await redis.hexists(key, 'chats')))
			chats[0]?.lastMessID && (await connection.execute(`INSERT INTO last_seen (mess, user) VALUES (?, ?) ON DUPLICATE KEY UPDATE mess = VALUES(mess)`, [chats[0].lastMessID, userID])),
				await redis.hset(key, 'chats', 0);
		else if (mode === 'getArchivedChats' && (await redis.hexists(key, 'archive')))
			await connection.execute(`UPDATE chat_members SET miss_arc = 0 WHERE id = ? AND archived = 1`, [userID]), await redis.hset(key, 'archive', 0);
	}
	return { chats };
}

/** ----------------------------------------------------------------------------
 * OPEN CHAT
 * Fetches messages, members, and syncs seen status.
 * Optimized to only fetch changed data based on client-provided sync timestamps.
 * -------------------------------------------------------------------------- */
async function openChat({ res: response, chatID, firstID, lastID, cursor, last, getPunInfo, membSync, seenSync, userID, message, con: connection }: any) {
	// OPEN CHAT SYNC ---------------------------------------------------------
	// Steps: validate params, optionally fetch members delta by membSync, optionally fetch seen delta by seenSync, fetch messages, optionally post message, optionally fetch punish info.
	if (!chatID || [cursor, membSync, seenSync, firstID, lastID, last].some(value => value && isNaN(parseInt(value as any)))) throw new Error('badRequest');
	const [rows]: [any[], any] = await connection.execute(`SELECT type FROM chats WHERE id = ?`, [chatID]);
	const type = rows[0]?.type;
	if (!type) throw new Error('badRequest');

	let membersData: any = {},
		seenData: any = {};

	// SYNC MEMBERS: If timestamp changed, fetch new member list
	if (!membSync || type !== 'private') {
		let lastChange: any = membSync && (await redis.hget(REDIS_KEYS.lastMembChangeAt, chatID));
		if (membSync && !lastChange) {
			const [rows]: [any[], any] = await connection.execute(`SELECT changed FROM chats WHERE id=?`, [chatID]);
			lastChange = rows[0]?.changed?.getTime() || 0;
			await redis.hset(REDIS_KEYS.lastMembChangeAt, chatID, lastChange);
		}
		if (!membSync || membSync < lastChange) membersData = await getMembers({ chatID, membSync, con: connection });
	}
	// SYNC SEEN: If timestamp changed, fetch new read receipts
	if (type !== 'private' && !message) {
		const lastChange = seenSync && (await redis.hget(REDIS_KEYS.lastSeenChangeAt, chatID));
		if (!seenSync || !lastChange || Number(seenSync) < Number(lastChange)) seenData = await fetchSeenUpdates({ chatID, chatType: type, seenSync, lastChange: lastChange, con: connection });
	}

	// PARALLEL FETCH: Messages + New Post (optional) + Punishment Info
	const [messagesResult, postResult, punishResult]: [any, any, any] = await Promise.all([
		getMessages({ res: response, firstID, lastID, cursor, userID, last, chatID, con: connection }),
		message && messageHandlers.postMessage({ message, chatID, userID, con: connection, redis }),
		getPunInfo && connection.execute(`SELECT punish, until, mess, who FROM chat_members WHERE chat=? AND id=? AND punish IS NOT NULL`, [chatID, userID]),
	]);
	return delFalsy({ ...messagesResult, ...membersData, ...seenData, ...postResult, ...(punishResult?.[0]?.[0] && { punInfo: punishResult[0][0] }) });
}

/** ----------------------------------------------------------------------------
 * LEAVE CHAT
 * Soft-deletes user from chat (flag='del', role='spect').
 * Downgrades chat type (e.g., Group -> Free) if the last admin leaves.
 * -------------------------------------------------------------------------- */
async function leaveChat({ chatID, role, userID, con: connection }: any) {
	// LEAVE CHAT -------------------------------------------------------------
	// Steps: in transaction, downgrade chat type if last leader leaves, soft-delete member row, then update redis roles/members and socket room membership.
	const result = await chatTransaction(connection, async () => {
		const { type, admins } = await getLeaders(connection, chatID);
		let newType;
		// If leader leaves, check if chat needs downgrade
		if (['VIP', 'admin'].includes(role) && ['VIP', 'group'].includes(type)) {
			if (type === 'VIP' ? role !== 'VIP' : role !== 'admin') throw new Error('badRequest');
			if (type === 'VIP' ? admins.length : !admins.filter((id: any) => id !== userID).length) newType = type === 'VIP' ? 'group' : 'free';
			if (newType)
				await connection.execute(`UPDATE chats SET type=?, changed=NOW() WHERE id=?`, [newType, chatID]),
					newType === 'free' && (await connection.execute(`UPDATE chat_members SET role='member' WHERE chat=?`, [chatID]));
		}
		// Soft delete member
		await connection.execute(`UPDATE chat_members SET flag='del', role='spect', last=COALESCE(last, (SELECT last_mess FROM chats WHERE id=?)) WHERE chat=? AND id=?`, [chatID, chatID, userID]);
		const [rows]: [any[], any] = await connection.execute(`SELECT last FROM chat_members WHERE chat=? AND id=?`, [chatID, userID]);
		return { newType, last: rows[0]?.last };
	});

	const now = Date.now();
	// Update Cache & Broadcast
	await setRolesAndLasts({ memberIDs: [userID], chatID, lastAllowedMess: result.last, role: 'spect', delFromMembers: true, setMembChange: now });
	await manageUsersInChatRoom({ chatID, userIDs: [userID], mode: 'rem' });
	if (result.newType) broadcastChatChanged({ chatID, chatObj: { id: chatID, type: result.newType } });
	broadcastMembersChanged({ chatID, members: [{ id: userID, role: 'spect', flag: 'del' }], membSync: now });
	return { newType: result.newType };
}

/** ----------------------------------------------------------------------------
 * END CHAT
 * Marks chat as ended, demotes all members to spectators.
 * Cleans up Redis cache and disconnects sockets.
 * -------------------------------------------------------------------------- */
async function endChat({ chatID, role, con: connection }: any) {
	// END CHAT ---------------------------------------------------------------
	// Steps: validate leader constraints, mark chat ended + demote members, then clear redis caches and force sockets to leave/end chat.
	const { type, admins } = await getLeaders(connection, chatID);
	// Only sole admin/VIP can end chat
	if (type === 'private' || !type || (type === 'VIP' && role !== 'VIP') || (type === 'group' && (role !== 'admin' || admins.length !== 1)))
		throw new Error(type === 'private' ? 'cannotEndPrivateChat' : 'unauthorized');

	await chatTransaction(connection, async () => {
		await connection.execute(`UPDATE chats SET ended=1, changed=NOW() WHERE id=?`, [chatID]);
		await connection.execute(`UPDATE chat_members SET role='spect', punish=NULL, who=NULL, mess=NULL, until=NULL, last=(COALESCE(last, (SELECT last_mess FROM chats WHERE id=?))) WHERE chat=?`, [
			chatID,
			chatID,
			chatID,
		]);
	});

	const ids: (string | number)[] = await getMembers({ IDsOnly: true, chatID, con: connection, includeArchived: true });
	await Promise.all([
		redis.del(`${REDIS_KEYS.chatMembers}:${chatID}`),
		redis.hdel(REDIS_KEYS.lastMembChangeAt, chatID),
		setRolesAndLasts({ memberIDs: ids, chatID, role: 'spect' }),
		endSocket({ chatID, memberIDs: ids }),
	]);
}

// MAIN ROUTER HANDLER ---------------------------------------------------------
// Dispatches requests to specific handler functions based on mode.

const handlers = { getMessages, createChat, setupChat, getMembers, openChat, messSeen, leaveChat, endChat, getChats, getHiddenChats: getChats, getArchivedChats: getChats, getInactiveChats: getChats };

export async function Chat(request: ChatRequest, response: any = null) {
	// CHAT MODULE ENTRY ------------------------------------------------------
	// Steps: open DB connection first, then authorize role for protected modes (reusing same connection), dispatch to handler, return payload, and route errors through Catcher.
	let connection: any;
	try {
		connection = await Sql.getConnection();
		// AUTH CHECK: Ensure user has role/access to specific operations
		// CONNECTION REUSE ----------------------------------------------------
		// Steps: pass connection to authorizeRole to avoid opening a second connection on cache misses; eliminates connection pool exhaustion under high traffic.
		if (needsAuth.has(request.body.mode)) {
			const [role, last] = await authorizeRole({ ...request.body, con: connection });
			if (!role) throw new Error('unauthorized');
			Object.assign(request.body, { role, last });
		}

		// DISPATCH
		const payload = await (
			handlers[request.body.mode] ||
			extHandlers[request.body.mode] ||
			(() => {
				throw new Error('badRequest');
			})
		)({ ...request.body, con: connection, redis, socket: request.body.socket });
		return response?.status(200)[payload ? 'json' : 'end'](payload) || payload;
	} catch (error) {
		Catcher({ origin: 'Chat', error: error as Error, res: response, context: request.body });
		if (!response) throw error;
	} finally {
		connection?.release();
	}
}
