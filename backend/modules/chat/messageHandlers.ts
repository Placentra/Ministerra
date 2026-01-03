import { encode } from 'cbor-x';
import { getLogger } from '../../systems/handlers/logging/index';
import { joinRoom, broadcastMessage } from '../../systems/socket/chatHandlers';
import { toMySqlDateFormat } from '../../../shared/utilities';

const logger = getLogger('ChatMessageHandlers');
const STREAM_MAXLEN = Number(process.env.STREAM_MAXLEN) || 50000;

// POST MESSAGE HANDLER ---------------------------------------------------------
// Steps: validate payload, allocate monotonic messID, persist via redis stream (durability boundary) with SQL fallback, optionally join room + fetch messages/members, then broadcast only after persistence so clients never see “ghost” messages.
async function postMessage({ chatID, message: { content = '', attach = null } = {}, userID, socket = null, alreadyInRoom = true, skipBroadcast = false, getMessages = null, getMembers = null, con, redis }: any) {
	// INPUT GUARD -------------------------------------------------------------
	// Steps: cap content size and require at least content or attachment so empty spam can’t be persisted/broadcast.
	if (content.length > 5000 || (!content && !attach)) throw new Error('badRequest');

	try {
		// MESSAGE ID + TIMING -------------------------------------------------
		// Steps: reserve id first so downstream systems (streams/DB/broadcast) can refer to a stable message id.
		const messID = await redis.incr('lastMessID');
		const created = Date.now();
		const dbTimestamp = toMySqlDateFormat(new Date(created));

		// PERSIST FIRST -------------------------------------------------------
		// Steps: append to stream so worker can bulk-write later; if stream fails, fall back to direct SQL insert to preserve UX.
		try {
			await redis.xadd('chatMessages', 'MAXLEN', '~', STREAM_MAXLEN, '*', 'payload', encode([messID, chatID, userID, content, attach, dbTimestamp]));
		} catch {
			await con.execute(`INSERT INTO messages (id, chat, user, content, attach) VALUES (?, ?, ?, ?, ?)`, [messID, chatID, userID, content, attach]);
		}

		let didJoinRoom, messages, members;

		// ROOM MEMBERSHIP -----------------------------------------------------
		// Steps: join only when needed; broadcast is gated on “in room” so private chats don’t leak to non-members.
		if (!alreadyInRoom) ({ didJoinRoom } = await joinRoom({ chatID, userID, con }));

		// OPTIONAL FETCHES ----------------------------------------------------
		// Steps: fetch expensive data only when caller asked for it; keeps “send message” path cheap under load.
		if (getMessages) {
			const result = await getMessages({ chatID, userID, con });
			messages = result?.messages;
		}
		if (getMembers) {
			const result = await getMembers({ chatID, userID, con });
			members = result?.members;
		}

		// BROADCAST AFTER PERSIST --------------------------------------------
		// Steps: broadcast only after persistence succeeded (stream append or SQL insert) so clients never render a message that later vanishes.
		if (!skipBroadcast && (alreadyInRoom || didJoinRoom)) broadcastMessage({ socket, chatID, mode: 'new', message: { id: messID, user: userID, content, attach, created } });
		return { messID, ...(didJoinRoom && { didJoinRoom: true }), ...(getMessages && { messages }), ...(getMembers && { members }) };
	} catch (error) {
		logger.error('postMessage', { error: error?.message, chatID, userID });
		throw new Error('messagePostFailed');
	}
}

// EDIT MESSAGE HANDLER ---------------------------------------------------------
// Updates message content/attachment for the author only, and only for recent messages.
// Broadcasts a minimal patch event so clients can update in-place.
// Steps: validate partial update intent, build a minimal SET clause, update only if author + within edit window, then broadcast a patch so clients can update without refetch.
async function editMessage({ chatID, message: { content = null, attach = null, id = null } = {}, userID, socket = null, con }: any) {
	// Require at least one non-empty field to update (prevent blanking messages)
	const hasContent = content !== null && content !== '';
	const hasAttach = attach !== null;
	if ((!hasContent && !hasAttach) || (content !== null && content.length > 5000)) throw new Error('badRequest');
	// Only update fields that are explicitly provided (non-null)
	const updates = [];
	const params = [];
	if (content !== null) {
		updates.push('content = ?');
		params.push(content);
	}
	if (attach !== null) {
		updates.push('attach = ?');
		params.push(attach);
	}
	if (!updates.length) throw new Error('badRequest');
	params.push(id, chatID, userID);
	// SQL UPDATE --------------------------------------------------------------
	// Steps: enforce author ownership and recency window so old messages can’t be rewritten later.
	const [result] = await con.execute(`UPDATE messages SET ${updates.join(', ')} WHERE id = ? AND chat = ? AND user = ? AND created > NOW() - INTERVAL 15 MINUTE`, params);

	if (!result.affectedRows) throw new Error('badRequest');
	// BROADCAST PATCH --------------------------------------------------------
	// Steps: broadcast minimal patch so UIs can update message in place without pulling full message list.
	broadcastMessage({ socket, chatID, mode: 'edi', message: { id, content, attach } });
	return { ok: true };
}

// DELETE MESSAGE HANDLER -------------------------------------------------------
// Soft deletes a message (flag='del'):
// - allowed for the original author
// - also allowed for moderation roles (admin/guard/VIP)
// Broadcasts a delete event so clients can hide/mark the message.
// Steps: load message owner, enforce author/moderator policy, set flag=del, then broadcast delete so clients converge without a full refetch.
async function deleteMessage({ chatID, messID, userID, socket = null, role, con }: any) {
	// OWNER LOOKUP ------------------------------------------------------------
	// Steps: confirm message exists and capture author id for permission and broadcast payload.
	const [[msg]] = await con.execute(`SELECT user FROM messages WHERE id = ? AND chat = ?`, [messID, chatID]);
	if (!msg) throw new Error('badRequest');

	const isAuthor = msg.user?.toString() === userID?.toString();
	const canDelete = isAuthor || ['admin', 'guard', 'VIP'].includes(role);
	if (!canDelete) throw new Error('unauthorized');

	// SOFT DELETE -------------------------------------------------------------
	// Steps: keep row (for audit/thread integrity) but mark deleted so clients hide it.
	const [result] = await con.execute(`UPDATE messages SET flag = 'del' WHERE id = ? AND chat = ?`, [messID, chatID]);
	if (!result.affectedRows) throw new Error('badRequest');
	broadcastMessage({ socket, chatID, mode: 'del', message: { id: messID, user: msg.user, who: userID } });
	return { ok: true };
}

// MESSAGE HANDLER EXPORTS ------------------------------------------------------
// Central map so the Chat module can dispatch by mode without dynamic imports.
export const messageHandlers = {
	postMessage,
	editMessage,
	deleteMessage,
};
