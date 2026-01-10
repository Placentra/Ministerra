import { getLogger } from '../handlers/loggers.ts';
import { getOnlineStatus } from './socket.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';
import { Chat } from '../../modules/chat.ts';
import { getMembers } from '../../modules/chat/chatHelpers.ts';

const logger = getLogger('ChatHandlers');
let [redis, socketIO] = [null, null];
// SETTERS ----------------------------------------------------------------------
// Steps: inject singleton clients so these helpers can be called from both HTTP modules and the socket layer without circular imports.
export const socketSetter = io => (socketIO = io);
export const ioRedisSetter = redisClient => (redis = redisClient);

const USER_ACTIVE_CHATS_TTL = 86400; // 24h

// HELPERS ---------------------------------------------------------------------
// Steps: keep emit semantics consistent whether the origin is a specific socket (exclude sender) or server-side IO (include all).
const broadcast = (sock, room, event, data) => (sock ? sock.broadcast.to(room) : socketIO.to(room)).emit(event, data);
const roomName = id => `chat_${id}`;

// ROOM MANAGEMENT -------------------------------------------------------------

// JOIN ROOM --------------------------------------------------------------------
// Steps: if chat room already has sockets, only join the caller and update minimal Redis state; if inactive, discover members,
// decide online/offline sets, materialize active sets + missed flags, then join all online members to the room in one operation.
export async function joinRoom({ userID, chatID, newChatObj = null, con }: any) {
	const id = Number(chatID ?? newChatObj?.id);
	const room = roomName(id);
	// ACTIVE ROOM CHECK -------------------------------------------------------
	// Steps: when room already has sockets, skip heavy member discovery and just join the caller (fast path).
	const isActive = !newChatObj && (await socketIO.in(room).allSockets()).size > 0;

	if (isActive) {
		const key = `userActiveChats:${userID}`;
		// ACTIVE FAST-PATH ---
		// Steps: update active set + TTL, apply missed flags for anyone previously “left”, then join sockets into the room.
		await Promise.all([redis.sadd(key, id), redis.expire(key, USER_ACTIVE_CHATS_TTL), setMissedChatsFlags(id, userID), socketIO.in(userID).socketsJoin(room)]);
		return { didJoinRoom: true };
	}

	// INACTIVE SLOW-PATH ---
	// Steps: fetch member list (Redis first, SQL fallback), compute online/offline sets, then decide whether to emit missed flags or activate the room.
	let members = newChatObj?.members?.map(m => m.id) || (await redis.smembers(`${REDIS_KEYS.chatMembers}:${id}`));
	if ((!members || !members.length) && con) {
		const res = await getMembers({ chatID: id, con });
		if (res?.members) members = res.members.map(m => m.id);
	}

	if (!members?.length) throw new Error('chatMembersNotFound');

	// ONLINE/OFFLINE PARTITION -----------------------------------------------
	// Steps: normalize IDs to strings for socket.io rooms, then compute online/offline so we can either (a) mark dots for offline, or (b) join everyone online.
	const memberStrings = members.map(String);
	const { online, offline } = await getOnlineStatus(memberStrings.filter(uid => uid != String(userID)));

	// OFFLINE-ONLY CASE ---
	// Steps: when nobody is online, skip room join work and just set the “chats” summary flag for offline users.
	if (!online.size) {
		const pipe = redis.multi();
		offline.forEach(uid => pipe.hset(`${REDIS_KEYS.userSummary}:${uid}`, 'chats', 1));
		await pipe.exec();
		return { didJoinRoom: false };
	}

	// ONLINE CASE ---
	// Steps: activate chat for all online users (and the joiner), set summary flags for offline users, then join online sockets to the room.
	const pipe = redis.multi();
	[...online, String(userID)].forEach(uid => {
		const key = `userActiveChats:${uid}`;
		pipe.sadd(key, id);
		pipe.expire(key, USER_ACTIVE_CHATS_TTL);
	});
	offline.forEach(uid => pipe.hset(`${REDIS_KEYS.userSummary}:${uid}`, 'chats', 1));
	await pipe.exec();

	// Join all online members to the room
	await socketIO.in(memberStrings).socketsJoin(room);
	return { didJoinRoom: true };
}

// MANAGE USERS IN ROOM ---------------------------------------------------------
// Steps: update Redis membership sets first (optionally on a caller-provided multi), build a queue of socket operations, then
// execute socket joins/leaves after Redis commit so room membership and persistence are consistent.
export async function manageUsersInChatRoom({ pipe = null, chatID, userIDs, mode, emitUserLeft = false, skipSocketsRemoval = false, skipChatLeftUsers = false }: any) {
	const room = roomName(chatID);
	// Only check activity if adding; removal doesn't depend on activity
	const isActive = mode !== 'rem' && (await socketIO.in(room).allSockets()).size > 0;
	const { online } = mode === 'rem' ? { online: new Set() } : await getOnlineStatus(userIDs);
	const t = pipe || redis.multi();
	const ops = [];

	userIDs.forEach(uid => {
		const isOnline = online.has(uid);
		const activeKey = `userActiveChats:${uid}`;
		const leftKey = `${REDIS_KEYS.chatLeftUsers}:${chatID}`;

		// Update Redis State
		if (mode === 'rem' && !skipChatLeftUsers) t.srem(leftKey, uid);
		if (mode === 'rem' || isActive) {
			t[mode === 'add' ? 'sadd' : 'srem'](activeKey, chatID);
			if (mode === 'add') t.expire(activeKey, USER_ACTIVE_CHATS_TTL);
		}
		// If adding to active room but user is offline, track them as "left" to notify later
		if (mode === 'add' && isActive && !isOnline) t.sadd(leftKey, uid);

		// Queue Socket Operations (executed after Redis commit)
		if (isOnline && isActive && (mode === 'add' || !skipSocketsRemoval)) ops.push({ uid, mode });
		if (mode === 'rem' && emitUserLeft) ops.push({ type: 'emit', uid });
	});

	if (!pipe) await t.exec();

	// SOCKET OPS FLUSH ---
	// Steps: run emits and room joins/leaves after Redis is committed (or return ops for caller-managed execution).
	const runOps = async () => {
		for (const op of ops) {
			if (op.type === 'emit') await socketIO.to(room).emit('userLeft', { chatID, userID: op.uid });
			else socketIO.in(op.uid)[op.mode === 'add' ? 'socketsJoin' : 'socketsLeave'](room);
		}
	};
	if (!pipe) await runOps();
	return { socketOps: ops }; // Return ops if caller handles execution (pipelined mode)
}

// END CHAT ---------------------------------------------------------------------
// Steps: clear left-users set, remove all users from active sets (reusing the shared helper), then leave sockets and optionally emit chatEnded.
export async function endChat({ chatID, memberIDs, skipChatEndedEmit = false }: any) {
	const t = redis.multi();
	t.del(`${REDIS_KEYS.chatLeftUsers}:${chatID}`);
	// Reuse manageUsers to remove everyone
	const { socketOps } = await manageUsersInChatRoom({ pipe: t, chatID, userIDs: memberIDs, mode: 'rem', skipChatLeftUsers: true });
	await t.exec();

	if (socketOps?.length) {
		const room = roomName(chatID);
		for (const op of socketOps) {
			if (op.type === 'emit') await socketIO.to(room).emit('userLeft', { chatID, userID: op.uid });
			else socketIO.in(op.uid).socketsLeave(room);
		}
	}
	if (!skipChatEndedEmit) socketIO.to(roomName(chatID)).emit('chatEnded', { chatID });
}

// SET MISSED FLAGS -------------------------------------------------------------
// Steps: read left-users set; for each user (except author), set summary flag, then clear left-users set so it is one-shot.
export async function setMissedChatsFlags(chatID, authorID) {
	const key = `${REDIS_KEYS.chatLeftUsers}:${chatID}`;
	if ((await redis.scard(key)) > 0) {
		const t = redis.multi();
		(await redis.smembers(key)).forEach(uid => uid != authorID && t.hset(`${REDIS_KEYS.userSummary}:${uid}`, 'chats', 1));
		t.del(key);
		await t.exec();
	}
}

// PROXY HANDLERS --------------------------------------------------------------

// MESSAGE PROXY ---------------------------------------------------------------
// Steps: validate mode+chatID, call Chat module with socket context, then ack with stable shape so clients can unify handling.
export async function sendMessage(socket, { message = {}, chatID, mode, joinRoom, messID }, cb) {
	try {
		if (!Number(chatID) || !['postMessage', 'editMessage', 'deleteMessage'].includes(mode)) return cb?.({ error: 'badRequest' });
		// Forward to Chat module
		const res = (await Chat({ body: { message, chatID, userID: socket.userID, mode, socket, alreadyInRoom: !joinRoom, messID } })) || {};
		cb({ messID: res.messID, ...(res.didJoinRoom && { didJoinRoom: true }) });
	} catch (e) {
		logger.error('sendMessage', { error: e?.message, chatID, mode });
		cb?.({ error: e.message || 'Message failed' });
	}
}

// GENERIC PROXY FACTORY --------------------------------------------------------
// Steps: create thin wrappers that forward to Chat with mode injected, while keeping consistent error logging + ack payloads.
const chatProxy = mode => async (socket, body, cb) => {
	try {
		await Chat({ body: { ...body, userID: socket.userID, socket, mode } });
		cb?.({ ok: true });
	} catch (e) {
		logger.error(mode, { error: e?.message, ...body });
		cb?.({ error: e.message });
	}
};

export const punishment = (s, b, c) => chatProxy(b.mode)(s, b, c);
export const messSeen = (s, b, c) => chatProxy('messSeen')(s, b, c);
export const blocking = (s, b, c) => chatProxy(b.mode)(s, b, c);

// BROADCASTS ------------------------------------------------------------------
// Helper functions to emit typed events to chat rooms or specific users

export const broadcastPunishment = ({ socket = null, chatID, targetUserID, how, mess = null, until = null, who, membSync = null }: any) => {
	const pl = { chatID, how, mess, until, membSync, userID: targetUserID, who };
	if (targetUserID) socketIO.to(String(targetUserID)).emit('punishment', pl); // Notify target directly
	(socket ? socket.broadcast.to(roomName(chatID)) : socketIO.to(roomName(chatID))).except(String(targetUserID)).emit('punishment', pl); // Notify room
};

export const broadcastBlocking = async ({ socket, chatID, mode, who, targetUserID }) => {
	const room = roomName(chatID);
	// If room active, broadcast to room. Else, emit to specific user channels.
	if ((await socketIO.in(room).allSockets()).size > 0) broadcast(socket, room, 'blocking', { chatID, who, mode });
	else socketIO.to(String(targetUserID)).to(String(who)).emit('blocking', { chatID, who, mode });
};

export const broadcastMessSeen = ({ socket = null, chatID, userID, messID }: any) => broadcast(socket, roomName(chatID), 'messSeen', { userID, chatID, messID });
export const broadcastMessage = ({ socket = null, chatID, mode, message }: any) => broadcast(socket, roomName(chatID), 'message', { mode, chatID, message });
export const broadcastMembersChanged = ({ socket = null, chatID, members, allMembers = null, membSync = null }: any) => broadcast(socket, roomName(chatID), 'membersChanged', { chatID, members, allMembers, membSync });
export const broadcastChatChanged = ({ socket = null, chatObj }: any) => broadcast(socket, roomName(chatObj.id), 'chatChanged', { chatObj });
export const broadcastNewChat = ({ socket = null, chatObj }: any) => chatObj && broadcast(socket, roomName(chatObj.id), 'newChat', chatObj);
