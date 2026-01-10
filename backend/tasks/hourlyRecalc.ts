import { Catcher } from '../systems/systems.ts';

// HOURLY RECALC ---------------------------------------------------------------
// Steps: advance archive pointer, mark miss_arc for users whose archived chats received new messages, and set summary dot in redis.
export default async function hourlyRecalc(con, redis) {
	try {
		// Ensure deterministic time behavior
		await con.execute(`SET time_zone = '+00:00'`);

		// GET LAST PROCESSED MESSAGE POINTER -----------------------------------------
		const [[{ lastArcMessId = 0 } = {}]] = await con.execute(`SELECT COALESCE(last_arc_mess_id, 0) AS lastArcMessId FROM miscellaneous WHERE id = 0`);

		// GET USERS WITH NEW MESSAGES  IN ARCHIVED CHATS -----------------------------------------
		const affectedUsersParams = [lastArcMessId];
		const affectedUsersQuery = `SELECT cm.chat AS chatId, cm.id AS userId, c.last_mess AS lastMess FROM chats c JOIN chat_members cm ON cm.chat = c.id WHERE c.last_mess > ? AND cm.archived = TRUE AND cm.seen < c.last_mess`;
		const [affectedUsers] = await con.execute(affectedUsersQuery, affectedUsersParams);

		// ADVANCE ARCHIVE MESAGE POINTER  -------------------------
		if (affectedUsers.length > 0) {
			// UPDATE MISSED MESSAGES FLAG IN ARCHIVED CHATS ------------------------------------
			const updatePairs = affectedUsers.map(() => '(?, ?)').join(', ');
			const updateParams = affectedUsers.flatMap(({ chatId, userId }) => [chatId, userId]);
			const updateMissArcQuery = `UPDATE chat_members SET miss_arc = 1 WHERE (chat, id) IN (${updatePairs}) AND miss_arc = 0`;
			await con.execute(updateMissArcQuery, updateParams);

			// ADVANCE ARCHIVE MESAGE POINTER (filter nulls to avoid -Infinity) ---------------------------
			const maxLastMess = Math.max(0, ...affectedUsers.map(user => user.lastMess).filter(v => v != null));
			await con.execute(`UPDATE miscellaneous SET last_arc_mess_id = ? WHERE id = 0`, [maxLastMess]);
			const pipe = redis.pipeline();
			for (const { userId } of affectedUsers) pipe.hset(`userSummary:${userId}`, 'archive', 1);
			await pipe.exec();
		}

		return { success: true, usersFlagged: affectedUsers.length };
	} catch (error) {
		Catcher({ origin: 'hourlyRecalc', error });
		return { error: true, message: error.message };
	}
}
