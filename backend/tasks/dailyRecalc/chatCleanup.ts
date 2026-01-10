// CHAT CLEANUP =================================================================
import { getIDsString } from '../../../shared/utilities.ts';
import { Querer } from '../../systems/systems.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';

const logger = getLogger('Task:DailyRecalc:ChatCleanup');

// UPDATE CHATS CHANGED STATUS ---------------------------
// Steps: pull affected chat_members rows, derive the minimal UPDATE set for chats/chat_members based on user transitions (del/fro/unfro/newName), then update redis membership/changed-at keys so sockets can refresh.
export async function updateChatsChangedStatus({ con, redis, allDelUserIDs, delUse, newNameUse, froUse, unfUse, now }) {
	const get = (ids, q) => (ids.size ? con.execute(q) : Promise.resolve([[]]));
	const queries = [
		get(allDelUserIDs, `SELECT id, chat FROM chat_members WHERE id IN (${getIDsString(allDelUserIDs)})`),
		get(newNameUse, `SELECT chat FROM chat_members WHERE id IN (${getIDsString(newNameUse)})`),
		get(froUse, `SELECT chat FROM chat_members WHERE id IN (${getIDsString(froUse)}) AND flag ='ok'`),
		get(unfUse, `SELECT chat FROM chat_members WHERE id IN (${getIDsString(unfUse)}) AND flag = 'fro'`),
	];

	const [[chatRows], [newNameChatRows], [froChatRows], [unfChatRows]] = await Promise.all(queries);
	const updateQueries = [],
		chats = chatRows.filter(r => delUse.has(r.id));

	if (chatRows.length) updateQueries.push(`UPDATE chats SET changed = NOW() WHERE id IN (${getIDsString(chatRows, 'chat')})`);
	if (chats.length) updateQueries.push(`UPDATE chats SET ended = 1 WHERE id IN (${getIDsString(chats, 'chat')}) AND type = 'private'`);
	if (newNameUse.size) updateQueries.push(`UPDATE chat_members SET changed = NOW() WHERE id IN (${getIDsString(newNameUse)})`);
	if (newNameChatRows.length) updateQueries.push(`UPDATE chats SET changed = NOW() WHERE id IN (${getIDsString(newNameChatRows, 'chat')})`);
	if (froChatRows.length) updateQueries.push(`UPDATE chats SET changed = NOW() WHERE id IN (${getIDsString(froChatRows, 'chat')})`);
	if (delUse.size) updateQueries.push(`UPDATE chat_members SET changed = NOW(), flag = 'del' WHERE id IN (${getIDsString(delUse)})`);
	if (froUse.size) updateQueries.push(`UPDATE chat_members SET changed = NOW(), prev_flag = flag, flag = 'fro' WHERE id IN (${getIDsString(froUse)}) AND flag = 'ok'`);
	if (unfUse.size) updateQueries.push(`UPDATE chat_members SET changed = NOW(), flag = prev_flag, prev_flag = NULL WHERE id IN (${getIDsString(unfUse)})`);

	// SQL UPDATES ------------------------------------------------------------
	// Steps: apply in one atomic sequence so chat “changed” timestamps and member flags move together.
	if (updateQueries.length)
		try {
			await Querer({ con, queries: updateQueries, task: 'updateChatsChangedStatus', mode: 'atomic_seq' });
		} catch (error) {
			logger.error('dailyRecalc.update_chats_changed_status_failed', { error, queries: updateQueries });
			throw error;
		}

	// REDIS MEMBERSHIP/CHANGE MARKERS ----------------------------------------
	// Steps: reflect deletions/unfro/name changes into redis membership sets and last-change timestamps so online clients can reconcile.
	const pipe = redis.pipeline();
	chatRows.forEach(({ id, chat }) => (pipe.srem(`${REDIS_KEYS.chatMembers}:${chat}`, id), pipe.hset(REDIS_KEYS.lastMembChangeAt, chat, now)));
	[...newNameChatRows, ...unfChatRows].forEach(({ chat }) => pipe.hset(REDIS_KEYS.lastMembChangeAt, chat, now));
	await pipe.exec();
}

// UPDATE CHAT DEAD STATUS ---------------------------
// Steps: pick a message id threshold (3 months old), mark chats dead when their last_mess falls behind it, and clear dead when activity resumes.
export async function updateChatDeadStatus({ con }) {
	const id = (await con.execute(`SELECT MAX(id) AS i FROM messages WHERE created < NOW() - INTERVAL 3 MONTH`))[0][0]?.i ?? (await con.execute(`SELECT MIN(id) AS i FROM messages`))[0][0]?.i;
	if (id !== undefined && id !== null) {
		await con.execute(`UPDATE chats SET dead = 1 WHERE dead = 0 AND last_mess < ?`, [id]);
		await con.execute(`UPDATE chats SET dead = 0 WHERE dead = 1 AND last_mess >= ?`, [id]);
	} else await con.execute(`UPDATE chats SET dead = 0 WHERE dead = 1`);
}
