// PAST EVENTS PROCESSING =======================================================
import { decode } from 'cbor-x';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('Task:DailyRecalc:PastEvents');

// RECALC PAST EVENTS ---------------------------
// Steps: clear any cached past-event artifacts for the current window, fetch event metas from redis, decode safely, then reuse the removal processor to
// delete redis state and trigger user recalcs where needed.
export async function recalcPastEvents({ redis, pastEveIDs, now, remEveMetasProcessor, userMetasProcessor, state }) {
	try {
		const cached = await redis.zrangebyscore(REDIS_KEYS.pastEveCachedAt, now, '+inf'),
			pipe = redis.pipeline();
		if (cached.length) {
			cached.forEach(id => pipe.del(`pastEve:${id}`));
			pipe.hdel(REDIS_KEYS.eveMetas, ...cached);
		}
		await pipe.zremrangebyscore('pastEveCachedAt', now, '+inf').exec();

		// EMPTY SHORT-CIRCUIT ---
		// Steps: avoid hmgetBuffer when there are no candidates.
		if (!pastEveIDs.length) return;
		const data = (await redis.hmgetBuffer(REDIS_KEYS.eveMetas, ...pastEveIDs))
			.map((m, i) => {
				try {
					return m ? [pastEveIDs[i], decode(m)] : null;
				} catch (e) {
					logger.error('dailyRecalc.decode_past_event_failed', { e, eventId: pastEveIDs[i] });
					return null;
				}
			})
			.filter(Boolean);

		// DELETION PIPELINE ---
		// Steps: queue deletions into a pipeline so downstream removal work flushes in one redis exec.
		const deletionsPipe = redis.pipeline();
		await remEveMetasProcessor({ data, state, deletionsPipe, userMetasProcessor });
		try {
			await deletionsPipe.exec();
		} catch (e) {
			logger.error('dailyRecalc.deletions_pipe_failed', { e });
		}
	} catch (e) {
		logger.error('dailyRecalc.recalc_past_events_failed', { e });
	}
}

// RECALC AFFECTED PAST EVENT USERS ---------------------------
// Steps: for scored (a*) past events, collect impacted user IDs from zsets, load user metas, decode, then run user meta processor in 'rem' mode.
export async function recalcAffectPastEveUsers({ redis, pastEve, userMetasProcessor }) {
	const ids = pastEve.filter(e => e.type.startsWith('a')).map(e => e.id);
	if (!ids.length) return;

	const users = (await redis.pipeline(ids.map(id => ['zrange', `${REDIS_KEYS.friendlyEveScoredUserIDs}:${id}`, 0, -1])).exec()).flatMap(([err, uids]) => (err ? [] : uids.map(u => u.split('_')[0])));
	if (!users.length) return;

	const data = (await redis.hmgetBuffer(REDIS_KEYS.userMetas, ...users))
		.map((m, i) => {
			try {
				return m ? [users[i], decode(m)] : (logger.alert('dailyRecalc.missing_affect_user_meta', { userId: users[i] }), null);
			} catch (e) {
				logger.error('dailyRecalc.decode_affect_user_failed', { e, userId: users[i] });
				return null;
			}
		})
		.filter(Boolean);

	await userMetasProcessor({ data, is: 'rem' });
}
