// CHAT MESSAGES TASK -----------------------------------------------------------
// Consumes the `chatMessages` redis stream and persists new messages into SQL.
// This is run by the worker thread scheduler; it is safe to be called repeatedly (no-op when stream is empty).

import { Writer, drainStream } from '../systems/systems';
import { getLogger } from '../systems/handlers/logging/index';

const logger = getLogger('Task:ChatMessages');

// PROCESS CHAT MESSAGES --------------------------------------------------------
// Steps: drain stream via consumer group, bulk insert message rows, compute per-chat max message id to update chats.last_mess, ack only after SQL writes succeed, then emit backlog warnings.
async function processChatMessages(con, redis) {
	try {
		const streamName = 'chatMessages';

		// STREAM DRAIN ---------------------------------------------------------
		// Steps: read bounded batches; the returned ack function is called only after persistence succeeds.
		const {
			items: allItems,
			ack: ackWithRetry,
			warn,
		} = await drainStream({
			redis,
			streamName,
			group: 'chatMessages',
			consumer: `worker-${process.pid}`,
			logPrefix: '[processChatMessages]',
		});

		// EMPTY SHORT-CIRCUIT --------------------------------------------------
		// Steps: avoid SQL writes and ack calls when stream is empty.
		if (!allItems.length) {
			return {
				processed: { chatMessages: 0, alerts: 0 },
				streamName,
				success: true,
			};
		}

		// SQL INSERT -----------------------------------------------------------
		// Steps: insert message rows; duplicates are handled by DB constraints (or rejected).
		// NOTE: Use insertIgnore because the fallback path in messageHandlers.ts may have already inserted the message directly when stream add fails with a network error after the XADD succeeded.
		const tasks = [
			{
				name: 'newMessages',
				arrs: allItems,
				table: 'messages',
				cols: ['id', 'chat', 'user', 'content', 'attach', 'created'],
				onDupli: [],
				is: 'insertIgnore',
			},
		];

		await Writer({ mode: 'chatMessages', tasksConfig: tasks, redis, con });

		// LAST_MESS UPDATE -----------------------------------------------------
		// Steps: compute max message id per chat from the same batch so chats table stays aligned with inserted messages.
		if (allItems.length > 0) {
			const lastMessagesByChat = {};

			// MAX PER CHAT ---
			// Steps: one pass; keep only the largest id for each chat; use Number() since CBOR decode already returns numeric types.
			for (const message of allItems) {
				const messageId = Number(message[0]);
				const chatID = message[1];
				if (!Number.isFinite(messageId) || chatID == null) continue;

				if (!(chatID in lastMessagesByChat) || messageId > lastMessagesByChat[chatID]) {
					lastMessagesByChat[chatID] = messageId;
				}
			}

			const chatUpdates = Object.entries(lastMessagesByChat).map(([chatID, messageId]) => [messageId, chatID]);

			if (chatUpdates.length > 0) {
				const chatUpdateTask = {
					name: 'chatsLastMessage',
					arrs: chatUpdates,
					table: 'chats',
					cols: ['last_mess'],
					colsDef: ['BIGINT', 'INT'],
					where: ['id'],
					is: 'replace',
				};
				await Writer({ mode: 'chatsLastMessage', tasksConfig: [chatUpdateTask], redis, con });
			}
		}

		// ACK AFTER WRITE ------------------------------------------------------
		// Steps: ack only after SQL insert + last_mess update have succeeded, so the stream remains the durability boundary.
		if (ackWithRetry) {
			try {
				await ackWithRetry();
			} catch (error) {
				logger.error('chatMessages.ack_failed', { error });
			}
		}

		// Backlog and near-cap warnings
		if (warn) await warn();

		// Return processing results with stream metrics
		return {
			success: true,
			processed: {
				chatMessages: allItems.length,
			},
		};
	} catch (error) {
		logger.error('chatMessages.unhandled', { error });
		return {
			success: false,
			error: error.message,
			streamName: 'chatMessages',
		};
	}
}

export default processChatMessages;
