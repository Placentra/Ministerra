import { linksHandler, blocksHandler } from '../useLinksAndBlocks';
import { forage } from '../../../helpers';
import { updateGalleryArrays } from '../../comp/bottomMenu/Gallery/updateGalleryArrays';

/** ----------------------------------------------------------------------------
 * ALERTS HANDLERS
 * Processes incoming socket events for notifications/alerts.
 * Handles updates for user data, links, interests, invites, ratings, and comments.
 * Merges new alerts with existing ones to avoid duplication.
 * -------------------------------------------------------------------------- */
export function createAlertsHandlers({ brain, setAlertsData, setNotifDots, showToast, setMenuView, navigate }) {
	const handleUserEvent = event => {
		// USER SYNC EVENT -----------------------------------------------------
		// Steps: merge partial user payload into brain.user, then add any new city objects so location-dependent UIs don't break on missing city refs.
		try {
			Object.assign(brain.user, event.data);
			event.data.citiesData?.forEach(city => !brain.cities.some(c => String(c.cityID) === String(city.cityID)) && brain.cities.push(city));
		} catch (error) {
			console.error('Error processing user event:', error);
		}
	};

	// LINKS AND BLOCKS ALERT HANDLER --------------------------------------
	// Steps: route to blocksHandler vs linksHandler (mutates brain), then optionally merge alert strip for non-block actions.
	async function handleLinksAndBlocksAlert(what, event) {
		try {
			const { target, dir, data = {} } = event;
			const blockModes = new Set(['block', 'unblock']);

			await (blockModes.has(what) ? blocksHandler : linksHandler)({
				obj: Object.assign(data, { id: target }),
				mode: what,
				id: target,
				direct: dir,
				isSocket: true,
				...data,
				brain,
			});
		} catch (error) {
			console.error(`Error processing ${what} event:`, error);
		}

		// Do not create alert strips for block/unblock
		if (what === 'block' || what === 'unblock') return;
		mergeAlerts(what, event);
	}

	// INTEREST ALERT HANDLER ----------------------------------------------
	// Steps: update local event counters if we have the event, then always merge alert so the notification UI stays consistent even when event isn't cached.
	async function handleInterestAlert(what, event) {
		const { target, data: { may = 0, sur = 0 } = {} } = event;
		const eventObj = brain.events[target];
		// Update in-memory event counts if available
		if (eventObj) {
			eventObj.maybe = (eventObj.maybe || 0) + Number(may || 0);
			eventObj.surely = (eventObj.surely || 0) + Number(sur || 0);
		}
		// Always call mergeAlerts to show notification, even if event not in memory
		mergeAlerts(what, event);
	}

	// INVITE ALERT HANDLER ------------------------------------------------
	// Steps: update brain.user invitesIn/invitesOut maps, keep gallery arrays in sync, persist user, then only emit a visible alert when not a deletion.
	async function handleInviteAlert(what, event) {
		try {
			const { target, data = {} } = event;
			const dir = data.dir || 'in';
			const flag = data.flag || 'ok';

			if (dir === 'in') {
				brain.user.invitesIn ??= {};
				const list = (brain.user.invitesIn[target] ??= []);
				const inviterId = data.user;

				if (inviterId != null) {
					const idx = list.findIndex(u => Number(u.id) === Number(inviterId));
					if (flag === 'del') {
						// Remove the cancelled invite
						if (idx > -1) list.splice(idx, 1);
						// If no more invites for this event, remove from gallery
						if (list.length === 0) {
							delete brain.user.invitesIn[target];
							updateGalleryArrays(brain, target, { removeFromInvitesIn: true });
						}
					} else {
						// Add or update invite
						const inviter = {
							id: inviterId,
							first: data.first,
							last: data.last,
							imgVers: data.imgVers || '',
							note: data.note,
							flag,
						};
						if (idx > -1) Object.assign(list[idx], inviter);
						else list.push(inviter);
						updateGalleryArrays(brain, target, { addToInvitesIn: true });
					}
				}

				const eve = brain.events[target];
				if (eve) {
					eve.invites ??= { in: brain.user.invitesIn[target] || [] };
					eve.invited = Array.isArray(eve.invites.in) && eve.invites.in.some(u => u && u.flag === 'ok');
				}

				await forage({ mode: 'set', what: 'user', val: brain.user });
			} else if (dir === 'out') {
				// updates on our outgoing invites when invitee responds or deletes
				brain.user.invitesOut ??= {};
				const list = (brain.user.invitesOut[target] ??= []);
				const inviteeId = data.user;
				if (inviteeId != null) {
					const idx = list.findIndex(u => Number(u.id) === Number(inviteeId));
					if (flag === 'del') {
						// Remove the deleted invite
						if (idx > -1) list.splice(idx, 1);
						// If no more invites for this event, remove from gallery
						if (list.length === 0) {
							delete brain.user.invitesOut[target];
							updateGalleryArrays(brain, target, { removeFromInvitesOut: true });
						}
					} else if (flag === 'acc' || flag === 'ref' || flag === 'ok') {
						const updated = { id: inviteeId, flag };
						if (idx > -1) Object.assign(list[idx], updated);
						else list.push(updated);
						updateGalleryArrays(brain, target, { addToInvitesOut: true });
					}
				}

				const eve = brain.events[target];
				if (eve) {
					eve.invites ??= { out: brain.user.invitesOut[target] || [] };
					const allUsers = Array.isArray(eve.invites.out) ? eve.invites.out : [];
					eve.invited = allUsers.some(u => u && u.flag === 'ok');
				}

				await forage({ mode: 'set', what: 'user', val: brain.user });
			}

			// Only create an alert notification if this is not a deletion
			if (flag !== 'del') {
				mergeAlerts(what, event);
			}
		} catch (err) {
			console.error('Error processing invite alert:', err);
		}
	}

	const findCommentRecursively = (commsData, targetId) => {
		// COMMENT TREE SEARCH ------------------------------------------------
		// Steps: depth-first walk the comment tree and return the first id match; used for comm_rating updates when we need to patch a nested reply/comment.
		for (const comm of commsData) {
			if (String(comm.id) === String(targetId)) return comm;
			if (comm.repliesData) {
				const reply = findCommentRecursively(comm.repliesData, targetId);
				if (reply) return reply;
			}
		}
		return null;
	};

	// RATING ALERT HANDLER -------------------------------------------------
	// Steps: apply score deltas to event/user/comment local objects when present, then merge alert so UI shows the update even if we couldn't patch local state.
	async function handleRatingAlert(what, event) {
		const { target, data = {} } = event;
		const points = Number((data.points ?? data.counts) || 0);

		if (what === 'eve_rating') {
			brain.events[target] ??= (await forage({ mode: 'get', what: 'past', id: target })) || { id: target };
			brain.events[target].score = (brain.events[target].score || 0) + points;
		} else if (what === 'user_rating' && points > 0) brain.user.score = (brain.user.score || 0) + points;
		else if (what === 'comm_rating') {
			const comment = findCommentRecursively(brain.events[data.event]?.commsData || [], target);
			if (comment && points) comment.score = (comment.score || 0) + points;
		}
		mergeAlerts(what, event);
	}

	// COMMENTS/REPLIES ALERT HANDLER --------------------------------------
	// Steps: bump comment counters on event, dispatch a DOM event so Discussion can react, then merge alert for notifications.
	async function handleCommentsAlert(what, event) {
		try {
			const { target, data = {} } = event;
			const isComment = what === 'comment';
			const eventId = isComment ? target : data.event;
			const parentCommentId = isComment ? null : target; // For replies, target is the parent comment ID

			if (eventId != null) {
				brain.events[eventId] ??= { id: eventId };
				if (typeof brain.events[eventId].comments === 'number') brain.events[eventId].comments++;

				// Dispatch event for Discussion to listen to
				// what: 'comment' = top-level comment, auto-refresh Discussion if sorted by recent
				// what: 'reply' = reply to comment, auto-refresh only if that comment's replies are open
				window.dispatchEvent(
					new CustomEvent('comments:new', {
						detail: { eventId, what, parentCommentId, commentId: data.comment },
					})
				);
			}

			await mergeAlerts(what, event);
		} catch (error) {
			console.error(`Error processing ${what} alert:`, error);
		}
	}

	const buildAlertKey = a => {
		// ALERT DEDUPE KEY ---------------------------------------------------
		// Steps: build a stable-ish key from actor+target+content snippet; for invites/interest/rating include extra fields so successive distinct updates don't collapse.
		const userKey = a.data?.user?.id || a.data?.user || `${a.data?.first || ''}${a.data?.last || ''}`;
		const eveKey = a.data?.title || '';
		const contentKey = (a.data?.content || '').slice(0, 20);
		if (a.what === 'invite') {
			const dir = a.data?.dir || '';
			const flagKey = a.flag || a.data?.flag || '';
			return `${a.what}:${dir}:${flagKey}:${a.target}:${userKey}:${eveKey}:${contentKey}`;
		}
		// For interest alerts, include counts to avoid collapsing identical events
		if (a.what === 'interest') {
			const countsKey = a.data?.sur || a.data?.may || a.data?.int ? `${a.data?.sur || 0},${a.data?.may || 0},${a.data?.int || 0}` : `${Date.now()}`;
			return `${a.what}:${a.target}:${countsKey}:${userKey}:${eveKey}:${contentKey}`;
		}
		// For rating alerts, include points to distinguish successive updates
		if (/(?:^|_)rating$/.test(a.what)) {
			const pts = a.data?.points ?? a.data?.counts ?? 0;
			return `${a.what}:${a.target}:${pts}:${userKey}:${eveKey}:${contentKey}`;
		}
		return `${a.what}:${a.target}:${userKey}:${eveKey}:${contentKey}`;
	};

	async function mergeAlerts(what, event) {
		// ALERT MERGE --------------------------------------------------------
		// Steps: ignore self-authored “link/accept” noise, normalize cancellations/refusals, dedupe by buildAlertKey, persist into brain.user.alerts and update dots/toasts.
		const { target, data = {} } = event;
		// Skip self-authored link/accept alerts and any block/unblock
		const actorId = Number(data.id || data.user || 0);
		if ((what === 'link' || what === 'accept') && actorId === brain.user.id) return;
		if (what === 'block' || what === 'unblock') return;

		const currentAlerts = Array.isArray(brain.user.alerts?.data) ? brain.user.alerts.data.slice() : [];
		if (what === 'refuse' || what === 'cancel') {
			const idx = currentAlerts.findIndex(a => a?.what === 'link' && Number(a?.target) === Number(target));
			if (idx > -1) {
				const existing = { ...currentAlerts[idx] };
				existing.flag = what === 'refuse' ? 'ref' : 'del';
				existing.refused = what === 'refuse';
				existing.accepted = false;
				existing.linked = false;
				existing.decisionAt = Date.now();
				existing.data = { ...existing.data, ...data };
				const nextAlerts = [...currentAlerts];
				nextAlerts[idx] = existing;
				brain.user.alerts ??= {};
				brain.user.alerts.data = nextAlerts;
				brain.user.alerts.lastFetch = Date.now();
				brain.user.alerts.cursors = brain.user.alerts.cursors || ['new', 0];
				await forage({ mode: 'set', what: 'alerts', val: brain.user.alerts });
				setAlertsData &&
					setAlertsData(prev => {
						if (!Array.isArray(prev)) return nextAlerts;
						return prev.map(alertItem => {
							if (alertItem?.what === 'link' && Number(alertItem?.target) === Number(target)) return { ...existing };
							return alertItem;
						});
					});
				return;
			}
		}

		const flag = typeof data?.flag === 'string' ? data.flag : undefined;
		const alert: any = { id: Date.now(), what, target, data: { ...data }, created: new Date().toISOString() };
		if (flag) alert.flag = flag;
		try {
			const keys = new Set(currentAlerts.map(buildAlertKey));
			const newKey = buildAlertKey(alert);
			const isRatingOrInterest = what === 'interest' || /(?:^|_)rating$/.test(what);
			const shouldAdd = isRatingOrInterest || !keys.has(newKey);

			// Do not deduplicate interest or rating alerts to ensure live updates always show
			if (shouldAdd) {
				const merged = [alert, ...currentAlerts];
				brain.user.alerts ??= {};
				brain.user.alerts.data = merged;
				brain.user.alerts.lastFetch = Date.now();
				brain.user.alerts.cursors = brain.user.alerts.cursors || ['new', 0];
				await forage({ mode: 'set', what: 'alerts', val: brain.user.alerts });
				// Only update the list in-memory; let the Alerts view manage sorting without resetting cursors
				setAlertsData && setAlertsData(prev => (Array.isArray(prev) ? [alert, ...prev] : merged));
			}
		} catch (e) {
			console.warn('Failed to append socket alert to local store:', e?.message);
		}

		const shouldToast = new Set(['link', 'accept', 'invite', 'interest', 'eve_rating', 'user_rating', 'comm_rating', 'comment', 'reply']).has(what);
		// Do not toast for self-authored link/accept or for block/unblock
		if ((what === 'link' || what === 'accept') && actorId === brain.user.id) return;
		if (what === 'block' || what === 'unblock') return;
		if (shouldToast) {
			createToast({ what, target, data });
		}
	}

	function createToast({ what, target, data }) {
		const toastConfig = {
			alert: { what, target, data, created: Date.now() },
			brain,
			placement: 'top',
			timeout: 5000,
			onToastClick: () => {
				({
					invite: () => {
						brain.showGalleryCat = 'invites';
						setMenuView('gallery');
					},
					link: () => {
						brain.showGalleryCat = 'links';
						setMenuView('gallery');
					},
					interest: () => {
						navigate(
							`/event/${target}!${encodeURIComponent(data.title || '')
								.replace(/\./g, '-')
								.replace(/%20/g, '_')}#discussion`
						);
					},
					accept: () => {
						brain.showGalleryCat = 'links';
						setMenuView('gallery');
					},
					comment: () => {
						const eveId = target || data.event;
						if (!eveId) return;
						navigate(`/event/${eveId}#discussion`);
					},
					reply: () => {
						const eveId = data.event || target;
						if (!eveId) return;
						navigate(`/event/${eveId}#discussion`);
					},
				})[what]?.() || console.warn(`Unknown alert type: ${what}`, { what, target, data });
			},
		};

		if (typeof showToast === 'function') showToast(toastConfig);
		setNotifDots?.(prev => ({ ...prev, alerts: 1 }));
		// Persist summary flag so the dot remains after reload
		(async () => {
			try {
				const stored = (await forage({ mode: 'get', what: 'alerts' })) || {};
				await forage({ mode: 'set', what: 'alerts', val: { ...stored, summary: { ...(stored.summary || {}), alerts: 1 } } });
			} catch (_) {}
		})();
	}

	return {
		handleUserEvent,
		handleLinksAndBlocksAlert,
		handleInterestAlert,
		handleInviteAlert,
		handleRatingAlert,
		handleCommentsAlert,
	};
}
