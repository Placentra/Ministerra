import { Catcher, Querer } from '../systems/systems.ts';
import { decode } from 'cbor-x';
import { getIDsString } from '../../shared/utilities.ts';
import { getStateVariables, processUserMetas, processRemEveMetas, processNewEvents, processNewEveMetas, loadMetaPipes, loadBasicsDetailsPipe, clearState } from '../utilities/contentHelpers.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { REDIS_KEYS, EVENT_COLUMNS } from '../../shared/constants.ts';
import { invalidateEventCache } from '../modules/event.ts';
import { invalidateUserCache } from '../modules/user.ts';

const logger = getLogger('Task:FlagChanges');

// PROCESS FLAG CHANGES ---------------------------------------------------------
// Steps: pull flagged rows from SQL, apply removals/priv changes/new events into redis metas + pipelines, invalidate in-process caches, then atomically persist DB deletions/flag resets.
async function processFlagChanges(con, redis) {
	try {
		const state = getStateVariables();
		const userMetasProcessor = async params => processUserMetas({ ...params, state, redis });

		const [remEve, remUse, privUse, newEve] = [new Set(), new Set(), new Map(), []];
		// Note: privsPipe removed - was created but never used, wasting resources
		const [deletionsPipe, metasPipe, basiDetaPipe, attenPipe] = Array.from({ length: 4 }, () => redis.pipeline());

		// FETCH SQL FLAGS -------------------------------------------------------
		// Steps: read the authoritative “what changed” signals from SQL first so redis work can be driven deterministically from the DB state.
		const eventsQ = `SELECT ${EVENT_COLUMNS} FROM events e INNER JOIN cities c ON e.cityID = c.id WHERE e.flag IN ('new', 'del')`;
		const usersQ = `SELECT id, flag, priv FROM users u WHERE u.flag IN ('fro', 'del', 'pri') GROUP BY u.id`;

		let events, users;
		try {
			[[events], [users]] = await Promise.all([eventsQ, usersQ].map(q => con.execute(q)));
		} catch (error) {
			logger.error('flagChanges.fetch_failed', { error, queries: { eventsQ, usersQ } });
			throw error;
		}

		const [froUse, delUse] = [new Set(), new Set()];
		events.forEach(({ flag, id }, idx) => (flag === 'new' ? newEve.push(events[idx]) : remEve.add(id)));
		users.forEach(user => (user.flag === 'pri' ? privUse.set(user.id, user.priv) : ((user.flag === 'fro' ? froUse : delUse).add(user.id), remUse.add(user.id))));

		if (!remEve.size && !remUse.size && !newEve.length && !privUse.size) {
			return { message: 'No flag changes to process' };
		}

		// PROCESS REMOVED EVENTS ---------------------------------------------------
		// Steps: load cached metas, decode, and feed deletion pipeline so downstream caches/pipelines drop any references.
		async function processRemEvents() {
			const remEveArr = [...remEve];
			if (!remEveArr.length) return;

			try {
				const metasBuffer = await redis.hmgetBuffer(REDIS_KEYS.eveMetas, ...remEveArr);
				const data = metasBuffer
					.map((meta, idx) => {
						try {
							return meta ? [remEveArr[idx], decode(meta)] : null;
						} catch (error) {
							logger.error('flagChanges.decode_removed_event_failed', { error, eventId: remEveArr[idx] });
							return null;
						}
					})
					.filter(Boolean);

				await processRemEveMetas({
					data,
					state,
					deletionsPipe,
					userMetasProcessor,
				});
			} catch (error) {
				logger.error('flagChanges.process_removed_events_failed', { error, eventIds: remEveArr });
			}
		}

		// PROCESS REMOVED USERS -------------------------------------------------
		// Steps: load user metas, decode, then run the same metas processor used elsewhere so removals cascade consistently.
		async function processRemUsers() {
			const remUseArr = [...remUse];
			if (!remUseArr.length) return;

			try {
				const metaBuffers = await redis.hmgetBuffer(REDIS_KEYS.userMetas, ...remUseArr);

				const data = metaBuffers
					.map((metaBuffer, idx) => {
						if (!metaBuffer) {
							logger.alert('flagChanges.missing_user_meta', { userId: remUseArr[idx] });
							return null;
						}

						try {
							const meta = decode(metaBuffer);
							return meta ? [remUseArr[idx], meta] : null;
						} catch (error) {
							logger.error('flagChanges.decode_removed_user_failed', { error, userId: remUseArr[idx] });
							return null;
						}
					})
					.filter(Boolean);

				await userMetasProcessor({ data, is: 'rem' });
			} catch (error) {
				logger.error('flagChanges.process_removed_users_failed', { error, userIdsTried: remUseArr });
			}
		}

		// PROCESS PRIVACIES CHANGES ----------------------------------------------
		// Steps: re-run metas processor with privUse map so per-user visibility/filters can be recomputed without full rebuild.
		async function processPrivChangeUsers() {
			const privUseArr = [...privUse.keys()];
			if (!privUseArr.length) return;

			try {
				const metaBuffers = await redis.hmgetBuffer(REDIS_KEYS.userMetas, ...privUseArr);
				const data = metaBuffers
					.map((metaBuffer, idx) => {
						if (!metaBuffer) {
							logger.alert('flagChanges.missing_priv_user_meta', { userId: privUseArr[idx] });
							return null;
						}
						try {
							return [privUseArr[idx], decode(metaBuffer)];
						} catch (error) {
							logger.error('flagChanges.decode_priv_user_failed', { error, userId: privUseArr[idx] });
							return null;
						}
					})
					.filter(Boolean);
				await userMetasProcessor({ data, is: 'pri', privUse });
			} catch (error) {
				logger.error('flagChanges.process_priv_users_failed', { error, userIds: privUseArr });
			}
		}

		// NEW EVENT IDS SNAPSHOT -----------------------------------------------
		// Steps: snapshot ids before processing because processNewEvents mutates the array.
		const newEveIds = newEve.map(({ id }) => id);

		if (newEve.length) {
			try {
				await processNewEvents({
					data: newEve,
					state,
					newEventsProcessor: async params => {
						processNewEveMetas({ ...params, state });
					},
				});
			} catch (error) {
				logger.error('flagChanges.process_new_events_failed', { error, eventIds: newEveIds });
			}
		}

		// APPLY META UPDATES ----------------------------------------------------
		// Steps: run removals + priv changes in parallel, then fill pipelines from state to produce the redis writes.
		await Promise.all([processRemEvents(), processRemUsers(), processPrivChangeUsers()]); // Parallel execution ---------------------------
		loadMetaPipes(state, metasPipe, attenPipe), loadBasicsDetailsPipe(state, basiDetaPipe);

		// INVALIDATE LOCAL CACHES ----------------------------------------------
		// Steps: invalidate per-process module caches after state/pipelines are ready, so the next request won’t serve stale entities.
		const affectedEventIDs = [...remEve];
		const affectedUserIDs = [...remUse, ...privUse.keys()];

		if (affectedEventIDs.length) affectedEventIDs.forEach(id => invalidateEventCache(id));
		if (affectedUserIDs.length) affectedUserIDs.forEach(id => invalidateUserCache(id));

		// SQL CLEANUP/ARCHIVE ---------------------------------------------------
		// Steps: build SQL that (1) clears new/pri flags, (2) archives deletions into rem_* tables, (3) deletes rows, and run it in an atomic sequence.
		const queries = [];
		if (newEveIds.length) queries.push(`UPDATE events SET flag = 'ok' WHERE id IN (${getIDsString(newEveIds)})`);
		if (remEve.size) {
			const remEveIds = getIDsString(remEve);
			// Column names must match rem_events schema exactly
			// Using SELECT * assumes schemas match, but field list is safer if schemas drifted
			queries.push(`INSERT INTO rem_events SELECT * FROM events WHERE id IN (${remEveIds})`);
			queries.push(`DELETE FROM events WHERE id IN (${remEveIds})`);
		}

		if (remUse.size) {
			if (delUse.size) queries.push(`INSERT INTO rem_users SELECT * FROM users WHERE id IN (${getIDsString(delUse)})`);
			if (froUse.size) queries.push(`INSERT INTO fro_users SELECT * FROM users WHERE id IN (${getIDsString(froUse)})`);
			if (remUse.size) queries.push(`DELETE FROM users WHERE id IN (${getIDsString(remUse)})`);
		}

		if (privUse.size) {
			queries.push(`UPDATE users SET flag = 'ok' WHERE id IN (${getIDsString([...privUse.keys()])})`);
		}

		if (queries.length > 0) {
			try {
				await Querer({ con, queries, task: 'flagChanges', mode: 'atomic_seq' });
			} catch (error) {
				logger.error('flagChanges.sql_transaction_failed', { error, queries });
				throw error;
			}
		}

		// REDIS PIPELINES COMMIT ------------------------------------------------
		// Steps: commit deletions first, then metas/detail/attendance writes; this keeps “remove first” semantics to minimize temporary visibility of stale content.
		await deletionsPipe.exec();
		await Promise.all([metasPipe.exec(), basiDetaPipe.exec(), attenPipe.exec()]);

		// STATE RESET -----------------------------------------------------------
		// Steps: clear shared state so subsequent calls don’t leak ids/maps across runs.
		clearState(state);
		const processedCount = newEveIds.length + remEve.size + remUse.size + privUse.size;
		[remEve, remUse, privUse].forEach(set => set.clear());
		newEve.length = 0;

		return {
			success: true,
			processed: processedCount,
		};
	} catch (error) {
		logger.error('flagChanges.unhandled', { error });
		Catcher({ origin: 'processFlagChanges', error });
		throw error;
	}
}

export default processFlagChanges;
