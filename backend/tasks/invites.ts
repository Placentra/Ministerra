import { Writer, drainStream } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../shared/constants.ts';
import { generateIDString } from '../utilities/idGenerator.ts';

const logger = getLogger('Task:Invites');

/**
 * Process invites from the redis stream
 * Steps: drain stream, normalize each item into an action, build DB inserts/deletes/updates, build per-recipient invite payloads for alert fanout,
 * persist bulk inserts via Writer, ack only after successful persistence, then warn on backlog.
 * @param {Object} con - MySQL connection
 * @param {Object} redis - Redis client
 * @param {Object} options - Processing options
 * @returns {Object} - Processing results
 */
async function processInvites(con, redis) {
	try {
		const streamName = 'newInvites';

		const {
			items: allItems,
			ack: ackWithRetry,
			warn,
		} = await drainStream({
			redis,
			streamName,
			group: 'invites',
			consumer: `worker-${process.pid}`,
			logPrefix: '[processInvites]',
		});

		// If no items were processed, return early
		if (!allItems.length) return {};
		const dbInvites = [];
		const userInvitesMap = new Map();

		// INVITE UPDATE ACCUMULATOR -------------------------------------------
		// Steps: accumulate per-recipient invite payloads; emitter consumes userInvitesMap to deliver online and mark offline.
		const pushInviteUpdate = (recipientId, targetEvent, data) => {
			if (!recipientId || !targetEvent || !data) return;
			const existing = userInvitesMap.get(recipientId) || [];
			existing.push({ what: 'invite', target: targetEvent, data });
			userInvitesMap.set(recipientId, existing);
		};

		// ACTION NORMALIZATION --------------------------------------------------
		// Steps: unify several producer shapes into a single action string so downstream switch stays stable.
		const getAction = item => {
			if (item.mode) return item.mode;
			if (item.event && Array.isArray(item.targetUsers)) return 'inviteUsers';
			if (item.targetUser && Array.isArray(item.events)) return 'inviteEvents';
			return null;
		};

		for (const item of allItems) {
			const action = getAction(item);
			try {
				switch (action) {
					case 'inviteUsers': {
						const { senderId, event, targetUsers, note = null } = item;
						if (!senderId || !event || !Array.isArray(targetUsers) || targetUsers.length === 0) break;

						const ts = Date.now();
						const pipe = redis.pipeline();

						for (const targetUser of targetUsers) {
							// Validate targetUser is a valid non-empty value
							if (targetUser == null || targetUser === '' || (typeof targetUser === 'string' && !targetUser.trim())) {
								logger.alert('invites.invalid_target_user', { senderId, event, targetUser });
								continue;
							}
							dbInvites.push([senderId, targetUser, event, note]);
							pushInviteUpdate(targetUser, event, { user: senderId, ...(note ? { note } : {}) });

							// Update Redis set and timestamp for Foundation caching
							pipe.sadd(`invites:${targetUser}`, event);
							pipe.hset(`${REDIS_KEYS.userSetsLastChange}:${targetUser}`, 'invites', ts);
						}
						await pipe.exec();
						break;
					}
					case 'inviteEvents': {
						const { senderId, targetUser, events, note = null } = item;
						if (!senderId || !targetUser || !Array.isArray(events) || events.length === 0) break;
						// Validate targetUser
						if (targetUser == null || targetUser === '' || (typeof targetUser === 'string' && !targetUser.trim())) {
							logger.alert('invites.invalid_target_user_in_events', { senderId, targetUser });
							break;
						}

						const ts = Date.now();
						const pipe = redis.pipeline();

						for (const event of events) {
							// Validate event ID
							if (event == null || event === '') {
								logger.alert('invites.invalid_event_id', { senderId, targetUser, event });
								continue;
							}
							dbInvites.push([senderId, targetUser, event, note]);
							pushInviteUpdate(targetUser, event, { user: senderId, ...(note ? { note } : {}) });

							// Update Redis set and timestamp for Foundation caching
							pipe.sadd(`invites:${targetUser}`, event); // targetUser is invited to these events? Wait.
							// inviteEvents: User X invites User Y (targetUser) to Events [A, B, C].
							// targetUser now has invites for events A, B, C.
							// Foundation checks invites:{targetUser}. Correct.
						}
						pipe.hset(`${REDIS_KEYS.userSetsLastChange}:${targetUser}`, 'invites', ts);
						await pipe.exec();
						break;
					}
					case 'cancel': {
						// CANCEL ONE -------------------------------------------------------
						// Remove invitation for specific event
						const { userID, targetEvent, targetUser } = item;
						if (!userID || !targetEvent || !targetUser) break;

						await redis.pipeline().srem(`invites:${targetUser}`, targetEvent).hset(`${REDIS_KEYS.userSetsLastChange}:${targetUser}`, 'invites', Date.now()).exec();

						await con.execute('DELETE FROM eve_invites WHERE user = ? AND user2 = ? AND event = ?', [userID, targetUser, targetEvent]);
						pushInviteUpdate(targetUser, targetEvent, { user: userID, dir: 'in', flag: 'del', storeAlert: false });
						break;
					}
					case 'cancelAll': {
						// CANCEL ALL -------------------------------------------------------
						// Steps: query recipients first, delete all outgoing invites for the event, then enqueue delete payloads per recipient.
						const { userID, targetEvent } = item;
						if (!userID || !targetEvent) break;
						const [rows] = await con.execute('SELECT user2 FROM eve_invites WHERE user = ? AND event = ?', [userID, targetEvent]);

						const ts = Date.now();
						const pipe = redis.pipeline();
						for (const row of rows || []) {
							if (!row?.user2) continue;
							pipe.srem(`invites:${row.user2}`, targetEvent);
							pipe.hset(`${REDIS_KEYS.userSetsLastChange}:${row.user2}`, 'invites', ts);
						}
						await pipe.exec();

						await con.execute('DELETE FROM eve_invites WHERE user = ? AND event = ?', [userID, targetEvent]);
						for (const row of rows || []) {
							if (!row?.user2) continue;
							pushInviteUpdate(row.user2, targetEvent, { user: userID, dir: 'in', flag: 'del', storeAlert: false });
						}
						break;
					}
					case 'delete': {
						// 'delete' action: userID (the invitee) is deleting their own received invite from targetUser (the sender)
						// Steps: soft-delete invite row for the invitee and enqueue an outgoing delete payload back to the sender (storeAlert=false).
						const { userID, targetUser, targetEvent } = item;
						if (!userID || !targetUser || !targetEvent) break;
						// user2 = invitee (userID), user = sender (targetUser)

						await redis.pipeline().srem(`invites:${userID}`, targetEvent).hset(`${REDIS_KEYS.userSetsLastChange}:${userID}`, 'invites', Date.now()).exec();

						await con.execute('UPDATE eve_invites SET flag = ? WHERE user2 = ? AND user = ? AND event = ?', ['del', userID, targetUser, targetEvent]);
						pushInviteUpdate(targetUser, targetEvent, { user: userID, dir: 'out', flag: 'del', storeAlert: false });
						break;
					}
					case 'deleteAll': {
						// DELETE ALL -------------------------------------------------------
						// Steps: soft-delete all invites for (invitee,event), then notify each sender that this invite is deleted on the invitee side.
						const { userID, targetEvent } = item;
						if (!userID || !targetEvent) break;

						await redis.pipeline().srem(`invites:${userID}`, targetEvent).hset(`${REDIS_KEYS.userSetsLastChange}:${userID}`, 'invites', Date.now()).exec();

						const [rows] = await con.execute('SELECT user FROM eve_invites WHERE user2 = ? AND event = ?', [userID, targetEvent]);
						await con.execute('UPDATE eve_invites SET flag = ? WHERE user2 = ? AND event = ?', ['del', userID, targetEvent]);
						for (const row of rows || []) {
							if (!row?.user) continue;
							pushInviteUpdate(row.user, targetEvent, { user: userID, dir: 'out', flag: 'del', storeAlert: false });
						}
						break;
					}
					case 'accept':
					case 'refuse': {
						// ACCEPT/REFUSE ----------------------------------------------------
						// Steps: update eve_invites + user_alerts flags for the invitee, create a sender-facing user_alerts row, set sender alerts dot, and enqueue a payload back.
						const { userID, targetUser, targetEvent } = item;
						if (!userID || !targetUser || !targetEvent) break;

						// INVITES SET SEMANTICS -------------------------------------------
						// Steps: `invites:{userID}` means "ever invited and not currently refused/deleted/canceled".
						// - refuse: remove from set (user opted out but can later accept)
						// - accept: (re)add to set (user opted back in)
						const inviteSetMutation = action === 'accept' ? 'sadd' : 'srem';
						await redis.multi()[inviteSetMutation](`invites:${userID}`, targetEvent).hset(`${REDIS_KEYS.userSetsLastChange}:${userID}`, 'invites', Date.now()).exec();

						const alertFlag = action === 'accept' ? 'acc' : 'ref';
						await con.execute('UPDATE eve_invites SET flag = ? WHERE user2 = ? AND user = ? AND event = ?', [alertFlag, userID, targetUser, targetEvent]);
						await con.execute('UPDATE user_alerts SET flag = ? WHERE user = ? AND what = ? AND target = ?', [alertFlag, userID, 'invite', targetEvent]);

						const inviteResponse = { user: userID, dir: 'out', flag: alertFlag };
						try {
							const [[userRow] = []] = await con.execute('SELECT first, last, imgVers FROM users WHERE id = ? LIMIT 1', [userID]);
							const [[eventRow] = []] = await con.execute('SELECT title FROM events WHERE id = ? LIMIT 1', [targetEvent]);
							if (userRow)
								Object.assign(inviteResponse, {
									first: userRow.first || '',
									last: userRow.last || '',
									imgVers: userRow.imgVers || '',
								});
							if (eventRow) Object.assign(inviteResponse, { title: eventRow.title || '' });
						} catch (e) {
							logger.alert('invites.enrich_payload_failed', { error: e, userID, targetEvent });
						}

						try {
							const alertID = generateIDString();
							await con.execute('INSERT INTO user_alerts (id, user, what, target, data, flag) VALUES (?, ?, ?, ?, ?, ?)', [
								alertID,
								targetUser,
								'invite',
								targetEvent,
								JSON.stringify(inviteResponse),
								alertFlag,
							]);
						} catch (e) {
							logger.error('invites.store_alert_failed', { error: e, userID, targetEvent });
						}

						if (redis) {
							try {
								await redis.hset(`userSummary:${targetUser}`, 'alerts', 1);
							} catch (e) {
								logger.alert('invites.update_user_summary_failed', { error: e, targetUser, targetEvent });
							}
						}

						pushInviteUpdate(targetUser, targetEvent, { ...inviteResponse, storeAlert: false });
						break;
					}
					default:
						break;
				}
			} catch (error) {
				logger.error('invites.process_action_failed', { error, action });
			}
		}

		// BULK INSERT -----------------------------------------------------------
		// Steps: insertIgnore so retries don’t explode DB load with duplicate key errors.
		if (dbInvites.length > 0) {
			await Writer({
				mode: 'invites',
				tasksConfig: [
					{
						name: 'invites',
						arrs: dbInvites,
						table: 'eve_invites',
						cols: ['user', 'user2', 'event', 'note'],
						is: 'insertIgnore',
					},
				],
				redis,
				con,
			});
		}

		// ACK AFTER WRITE ------------------------------------------------------
		// Steps: ack only after DB writes succeed so the stream remains the durability boundary.
		if (ackWithRetry) {
			try {
				await ackWithRetry();
			} catch (e) {
				logger.error('invites.ack_failed', { error: e });
			}
		}

		// Backlog and near-cap warnings
		if (warn) await warn();

		return { userInvitesMap };
	} catch (error) {
		logger.error('invites.unhandled', { error });
		return {
			taskName: 'invites',
			success: false,
			error: error.message,
			processed: 0,
		};
	}
}

export default processInvites;
