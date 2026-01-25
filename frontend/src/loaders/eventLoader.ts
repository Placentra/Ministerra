import axios from 'axios';
import { redirect } from 'react-router-dom';
import { forage, setPropsToContent, processMetas, extractInteractions } from '../../helpers';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import { INTERVALS } from '../../../shared/constants.ts';

// EVENT PAGE LOADER ------------------------------------------------------------
// Steps: resolve eventID, hydrate cached users if needed, decide whether to fetch based on state+sync+past/users requirements, then merge eventData+metas into brain and persist to forage (including past events).
export async function eventLoader(brain, params) {
	const eventID = params.eventID?.split('!', 1)[0];
	if (!eventID) return redirect('/');

	const [now, isGuest, unstableObj] = [Date.now(), !brain.user.id, brain.user.unstableObj];
	// PAST EVENT HYDRATION -------------------------------------------------------
	// Steps: prefer brain.user.pastEve cache, fall back to forage storage, and cache back into brain so navigation is instant next time.
	const pastEvent = await (async () => {
		if (brain.user.pastEve?.[eventID]) return brain.user.pastEve?.[eventID];
		const restored = await forage({ mode: 'get', what: 'past', id: eventID });
		// ENSURE PASTEVE EXISTS ---
		// Steps: initialize pastEve object if undefined to prevent null reference on assignment.
		if (restored) return ((brain.user.pastEve ??= {})[eventID] = restored);
		return null;
	})();

	let eve = pastEvent ?? brain.events[eventID] ?? (await forage({ mode: 'get', what: 'eve', id: eventID })) ?? { id: eventID, state: 'noMeta' };
	const { state = 'noMeta', cityID, basiVers = 1, detaVers = 1, starts, ends, type, usersSync: lastUsersSync = 0, sync: lastSync = 0, pastUsers: storedPastUsers } = eve;
	const isPast = storedPastUsers || (ends || starts) < Date.now();

	const cachedUserIDs = brain.user.eveUserIDs?.[eventID];
	const needsFetch = state !== 'basiDeta' || (!isPast && now - lastSync > INTERVALS.cityContentRefresh) || (type?.startsWith('a') && (isPast ? !storedPastUsers : !cachedUserIDs));
	if (cachedUserIDs?.length && cachedUserIDs.some(id => !brain.users[id])) {
		const restored = await forage({ mode: 'get', what: 'users', id: cachedUserIDs });
		const restoredUsers = setPropsToContent('users', restored || [], brain);
		for (const user of restoredUsers) if (user?.id) brain.users[user.id] = user;
	}

	try {
		if (needsFetch) {
			// FETCH PLAN ---------------------------------------------------------
			// Steps: decide whether we already “gotUsers” cheaply from recent city sync, decide whether to request SQL overlays (unstable), then call backend and merge into local objects.
			const citySync = brain.citiesContSync?.[cityID];
			const hasRecentCitySync = typeof citySync === 'number' && now - citySync < INTERVALS.cityContentRefresh;
			const gotUsers = type?.startsWith('a') && (!isPast ? (Boolean(brain.citiesEveTypesInTimes?.[cityID]) && hasRecentCitySync) || now - lastUsersSync < INTERVALS.cityContentRefresh : storedPastUsers);

			const body = {
				eventID,
				...(state === 'stale' ? { basiVers, detaVers } : { state }),
				...(unstableObj?.gotSQL?.events.includes(eventID) || (isPast && state !== 'stale') ? { gotSQL: true } : {}),
				...(gotUsers ? { gotUsers: true } : { lastUsersSync }),
			};
			const gotSQL = Boolean(body.gotSQL);

			const { eventData, eveMeta, userIDs: fetchedUserIDs, usersSync, pastUsers } = (await axios.post(`event`, body))?.data || {};
			if (eveMeta) await processMetas({ eveMetas: { [eventID]: eveMeta }, brain });
			if (fetchedUserIDs) brain.user.eveUserIDs[eventID] = fetchedUserIDs;
			else if (pastUsers) eve.pastUsers = setPropsToContent('users', pastUsers, brain);

			// NORMALIZATION ------------------------------------------------------
			// Steps: ensure ends/meetWhen are numeric timestamps; backend stores these as numbers but redis may return strings.
			const parsedEventData = {
				...(eventData || {}),
				...(eventData?.ends && { ends: Number(eventData.ends) }),
				...(eventData?.meetWhen && { meetWhen: Number(eventData.meetWhen) }),
			};

			Object.assign(eve, parsedEventData, {
				...(eveMeta && brain.events[eventID]),
				...(fetchedUserIDs?.length && { usersSync: usersSync || now }),
				state: 'basiDeta',
				sync: now,
			});

			// PERSISTENCE --------------------------------------------------------
			// Steps: for logged-in users, extract unstable interactions if needed, persist openEve/pastEve state, and always persist the event object into forage for offline/fast reload.
			if (!isGuest) {
				if (unstableObj && !gotSQL) extractInteractions([eve], 'events', brain, true);
				eve = setPropsToContent('events', [eve], brain)[0] || eve;

				if (!pastEvent && (['sur', 'may'].includes(eve.inter) || eve.own) && (eve.ends || eve.starts) < Date.now()) {
					await forage({ mode: 'set', what: 'past', id: eventID, val: eve });
					brain.user.pastEve[eventID] = eve;
				}

				brain.user.openEve = [...(brain.user.openEve || []).filter(id => id !== eve.id), eve.id];
				await forage({ mode: 'set', what: 'user', val: brain.user });
			}

			await forage({ mode: 'set', what: 'events', id: eventID, val: eve });
			brain.events[eventID] = eve;

			if (eve.title) {
				const eventUrl = `/event/${eventID}!${encodeURIComponent(eve.title).replace(/\./g, '-').replace(/%20/g, '_')}`;
				window.history.replaceState({}, '', eventUrl);
			}
		}

		return eve;
	} catch (error: any) {
		const errorData = error.response?.data;
		const errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
		if (errorCode === 'unauthorized' || error.response?.status === 401) {
			await forage({ mode: 'del', what: 'token' });
			return redirect('/entrance');
		}
		if (error.response?.status === 404 || errorCode === 'notFound' || error.message === 'notFound') {
			delete brain.events[eventID];
			if (brain.user.eveUserIDs) delete brain.user.eveUserIDs[eventID];
			return redirect('/');
		}
		notifyGlobalError(error, 'Nepodařilo se načíst událost.');
		throw error;
	}
}
