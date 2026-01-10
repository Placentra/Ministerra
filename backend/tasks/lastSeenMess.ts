import { Writer, drainStream } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';

const logger = getLogger('Task:LastSeenMess');

/**
 * Process last seen messages from the redis stream and store them in the database
 * Steps: drain stream via consumer group, collapse entries by (chatID,userID) to the maximum seen message ID, write into chat_members, then ack stream IDs.
 * @param {Object} con - MySQL connection
 * @param {Object} redis - redis client
 * @param {Object} options - Processing options
 * @returns {Object} - Processing results
 */
async function processLastSeenMess(con, redis, options = {}) {
	try {
		const streamName = 'lastSeenMess';
		const startTime = Date.now();

		// STREAM DRAIN ---------------------------------------------------------
		// Steps: drain a bounded batch window so we never block workers indefinitely; ack is returned for explicit post-write acknowledgement.
		const {
			items: allItems,
			ack: ackWithRetry,
			warn,
		} = await drainStream({
			redis,
			streamName,
			group: 'lastSeenMess',
			consumer: `worker-${process.pid}`,
			logPrefix: '[processLastSeenMess]',
		});

		// EMPTY SHORT-CIRCUIT --------------------------------------------------
		// Steps: avoid any SQL writes when there was nothing to process.
		if (!allItems.length) {
			return {
				processed: 0,
				streamName,
				streamLength: 0,
				remainingItems: 0,
			};
		}

		// DEDUPE + MAX ---------------------------------------------------------
		// Steps: multiple stream entries can exist for the same user/chat; keep only the largest messId so DB write is minimal and idempotent-ish.
		const maxSeenByPair = new Map();
		for (const raw of allItems) {
			const arr = Array.isArray(raw) ? raw : [];
			const [chatIdRaw, userIdRaw, messIdRaw] = arr;
			const chatID = Number(chatIdRaw),
				userId = userIdRaw,
				messId = Number(messIdRaw);
			if (!Number.isFinite(chatID) || userId == null || !Number.isFinite(messId)) continue;
			const key = `${chatID}:${userId}`;
			const prev = maxSeenByPair.get(key);
			if (prev == null || messId > prev) maxSeenByPair.set(key, messId);
		}

		const mapped = [];
		for (const [key, maxSeen] of maxSeenByPair.entries()) {
			const [chatIdStr, userIdStr] = key.split(':');
			mapped.push([maxSeen, Number(chatIdStr), userIdStr]); // [seen, chat, id]
		}

		// SQL WRITE ------------------------------------------------------------
		// Steps: replace seen pointer per (chat,id) so later reads reflect the newest seen state.
		await Writer({
			mode: 'lastSeenMess',
			tasksConfig: [
				{
					name: 'lastSeen',
					arrs: mapped,
					table: 'chat_members',
					cols: ['seen'],
					colsDef: ['BIGINT'],
					where: ['chat', 'id'],
					is: 'replace',
				},
			],
			redis,
			con,
		});

		// Calculate processing time and rate
		const processingTime = Date.now() - startTime;
		const processingRate = allItems.length / (processingTime / 1000);

		// ACK AFTER WRITE ------------------------------------------------------
		// Steps: only ack when DB write succeeded so the stream remains the durability boundary for at-least-once processing.
		if (ackWithRetry) {
			try {
				await ackWithRetry();
			} catch (error) {
				logger.error('lastSeenMess.ack_failed', { error });
			}
		}

		// Backlog and near-cap warnings
		if (warn) await warn();

		// Return processing results
		return {
			success: true,
			processed: allItems.length,
			streamName,
			streamLength: 0,
			remainingItems: 0,
			processingTime,
			processingRate,
		};
	} catch (error) {
		logger.error('lastSeenMess.unhandled', { error });
		return {
			success: false,
			error: error.message,
			streamName: 'lastSeenMess',
		};
	}
}

export default processLastSeenMess;
