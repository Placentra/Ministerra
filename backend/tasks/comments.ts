import { Writer, drainStream } from '../systems/systems.ts';
import { decode } from 'cbor-x';
import { getLogger } from '../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../shared/constants.ts';

const logger = getLogger('Task:Comments');
// COMMENTS TASK ----------------------------------------------------------------
// Consumes `eveComments` stream delta events produced by Discussion module:
// - updates replies counts for parent comments (sumUp)
// - emits structured `commentsAlerts` for downstream alert fanout
// - acks after successful persistence to avoid double processing
// Steps: drain stream, aggregate reply deltas per parentId, build alerts for new top-level comments/replies, persist reply count deltas, then ack stream ids.
async function processComments(con, redis) {
	try {
		const streamName = 'eveComments';

		const {
			items: allItems,
			ack: ackWithRetry,
			warn,
		} = await drainStream({
			redis,
			streamName,
			group: 'comments',
			consumer: `worker-${process.pid}`,
			logPrefix: '[processComments]',
		});

		// If no items were processed, return early
		if (!allItems.length) {
			return {
				success: true,
				processed: { comments: 0 },
			};
		}

		// DELTA AGGREGATION ----------------------------------------------------
		// Steps: fold each delta payload into (1) per-parent replies sumUp and (2) alert payloads for comment/reply creation.
		const targetCommsRepliesCount = new Map();
		const commentsAlerts = [];
		for (const payload of allItems) {
			try {
				// PAYLOAD SHAPE GUARD ------------------------------------------------
				// Steps: validate array shape first so malformed items are skipped without crashing the whole batch.
				if (!Array.isArray(payload) || payload.length < 6) {
					logger.alert('comments.invalid_payload_structure', { payload, length: payload?.length });
					continue;
				}
				const [kind, eventId, parentId, eventDelta, replyDelta, commentId] = payload;
				logger.info('comments.processing_payload', { kind, eventId, parentId, eventDelta, replyDelta, commentId });
				if (kind !== 'delta') continue;
				if (Number(parentId)) targetCommsRepliesCount.set(parentId, (targetCommsRepliesCount.get(parentId) || 0) + (Number(replyDelta) || 0));
				// ALERT BUILD -------------------------------------------------------
				// Steps: when the eventDelta indicates a new visible comment, load cached author/content preview from redis and emit a compact alert record.
				if ((Number(eventDelta) || 0) > 0) {
					const raw = await redis.hgetBuffer(REDIS_KEYS.commentAuthorContent, commentId);
					let user = null,
						content = '';
					if (raw) {
						try {
							const [u, prev] = decode(raw);
							user = u;
							content = prev || '';
						} catch (err) {
							logger.alert('comments.decode_author_failed', { error: err?.message, commentId });
						}
					}
					const isReply = Number(parentId) > 0;
					const alert = isReply
						? { what: 'reply', target: parentId, data: { user, event: eventId, comment: commentId, content } }
						: { what: 'comment', target: eventId, data: { user, comment: commentId, content } };
					logger.info('comments.generated_alert', { isReply, alert });
					commentsAlerts.push(alert);
				}
			} catch (error) {
				logger.error('comments.delta_parse_failed', { error, payload });
			}
		}

		// SQL SUMUP ------------------------------------------------------------
		// Steps: persist reply count deltas in one Writer call so parent comment reply counters remain consistent.
		if (targetCommsRepliesCount.size) {
			await Writer({
				mode: 'replies_counts',
				tasksConfig: [
					{
						name: 'replies_counts',
						arrs: [...targetCommsRepliesCount.entries()],
						table: 'comments',
						cols: ['replies'],
						colsDef: ['INT', 'INT'],
						where: ['id'],
						is: 'sumUp',
					},
				],
				redis,
				con,
			});
		}

		// ACK AFTER WRITE ------------------------------------------------------
		// Steps: ack only after SQL writes have succeeded so the stream remains the durability boundary.
		if (ackWithRetry) {
			try {
				await ackWithRetry();
			} catch (error) {
				logger.error('comments.ack_failed', { error });
			}
		}

		// Backlog and near-cap warnings
		if (warn) await warn();

		return {
			commentsAlerts,
			success: true,
			processed: { comments: allItems.length },
		};
	} catch (error) {
		logger.error('comments.unhandled', { error });
		return {
			taskName: 'comments',
			success: false,
			error: error.message,
			streamName: 'eveComments',
		};
	}
}

export default processComments;
