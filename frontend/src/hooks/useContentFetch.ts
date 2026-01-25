import { useRef, useEffect } from 'react';
import axios from 'axios';
import { forage, getFilteredContent, delUndef, extractInteractions, splitStrgOrJoinArr, fetchOwnProfile, trim } from '../../helpers';
import { notifyGlobalError } from './useErrorsMan';

/** ----------------------------------------------------------------------------
 * useContentFetch Hook
 * Manages content queue, fetching, caching, and unstable-device SQL fallbacks.
 * Handles both infinite scroll fetching and initial load.
 * --------------------------------------------------------------------------- */
export function useContentFetch({ brain, snap, avail, event, show, sherData, nowAt, contView, isPast, content, setContent, setCardsToContent, contentRef, setSnap, map, provideSnap, eveInter }) {
	const contQueue = useRef([]),
		disableInfinite = useRef(false),
		firstBatchReady = useRef(false);

	// TRIGGER FETCH / REORDER ---------------------------------------------------
	// Steps: when snap.fetch or page context demands, reset flags and run contentMan; for event attendee lists, just reorder current content to keep "me" pinned when attending.
	useEffect(() => {
		if (!event.id && !snap.fetch) return;
		if (snap.fetch || (nowAt !== 'home' && !content)) {
			(disableInfinite.current = true), (firstBatchReady.current = false), contentMan();
			setTimeout(() => (disableInfinite.current = false), 1000);
		} else if (nowAt === 'event' && event.type?.startsWith('a')) {
			const [curContent, isAttending] = [content || [], ['sur', 'may'].includes(eveInter)];
			let newContent =
				isAttending && curContent[0]?.id !== brain.user.id
					? [brain.user, ...curContent.filter(user => user.id !== brain.user.id)]
					: !isAttending && curContent.filter(user => user.id !== brain.user.id);
			if (newContent && (newContent.length !== curContent.length || newContent.some((user, i) => user.id !== curContent[i]?.id))) {
				setCardsToContent(newContent);
			}
		}
	}, [eveInter, snap.fetch, show.view, nowAt]);

	// CONTENT MANAGER ------------------------------------------------------------
	// Steps: build (or extend) a queue of candidate IDs, compute the next fetch slice based on usability, fetch basics (and optional SQL overlays), merge into brain caches, delete dead items, then slice usable items into UI state.
	async function contentMan(infinite = false) {
		// STALE GUARD ---
		// Steps: capture current queue version at start so we can detect if view switched during async work and skip stale writes.
		const startVersion = brain.contQueueVersion || 0;
		try {
			// USABILITY RULE --------------------------------------------------
			// Steps: treat basi-ish items as usable; for users view, allow self even when partially hydrated so UI can still render "me" card.
			const usable = item => item.state?.includes('basi') || (contView === 'users' && item.id == brain.user.id && item.first);
			let [gotSQLset, storeUser, unstableObj, actualyReceivedIDs, IDsToRemove, numOfUsable, IDsToFetch, interrupted] = [
				new Set(brain.user.unstableObj?.gotSQL[contView] || []),
				nowAt === 'event' && !event.userIDs,
				brain.user.unstableObj,
				new Set(),
				new Set(),
				0,
				[],
				false,
			];

			// QUEUE BUILD (NON-INFINITE) --------------------------------------
			// Steps: on initial fetch, derive queue from filter logic, ensure self profile if needed, and cache queue IDs for map/search flows.
			if (!infinite) {
				if (nowAt === 'event' && event.pastUsers?.length) return setCardsToContent(event.pastUsers);
				contQueue.current = getFilteredContent({ what: show.view === 'topEvents' ? 'topEvents' : 'content', brain, snap, avail, event, sherData, show });
				if (contQueue.current[0]?.id == brain.user.id && !brain.user.first) await fetchOwnProfile(brain);
				// VERSION CHECK ---
				// Steps: only update contQueueIDs if version hasn't changed during async work to prevent stale writes from old view.
				if (nowAt === 'home' && brain.contQueueVersion === startVersion) brain.contQueueIDs = contQueue.current.map(item => item.id || item);
			}

			// WINDOW SELECT ----------------------------------------------------
			// Steps: count usable items until the first unusable, then select a bounded ID window to fetch (home=20, event=4 unless past), so payloads stay small.
			const indexeMap = new Map();
			for (const [index, item] of contQueue.current.entries()) {
				indexeMap.set(item.id, index);
				if (item.id == brain.user.id) numOfUsable++;
				else if (!interrupted && usable(item)) numOfUsable++;
				else if (!interrupted || !usable(item)) (interrupted = true), IDsToFetch.push(item.id);
				if (IDsToFetch.length === (nowAt === 'home' ? 20 : isPast ? 20 : 4)) break;
			}

			// FETCH BASICS -----------------------------------------------------
			// Steps: fetch only when we have fewer usable than needed (or infinite), optionally request SQL overlays for unstable devices, then merge results into existing queue objects (reference-stable).
			if ((numOfUsable < (nowAt === 'home' ? 20 : isPast ? 20 : 4) && IDsToFetch.length) || infinite) {
				const getSQL = unstableObj ? IDsToFetch.filter(id => !gotSQLset.has(id)) : [];
				const axiPayload = { IDs: IDsToFetch, getSQL, contView };
				let basics: any;
				try {
					basics = (await axios.post('content', delUndef(axiPayload))).data as any;
				} catch (error) {
					notifyGlobalError(error, 'Nepodařilo se načíst obsah.');
					return;
				}

				// MERGE + UNSTABLE OVERLAYS -------------------------------------
				// Steps: extractInteractions when unstable so per-user overlays are applied locally; normalize fields (split arrays / numeric ends), then mark items as received and stage for persistence.
				if (unstableObj) extractInteractions(basics, contView, brain), (storeUser = true);
				const itemsToStore = [];

				for (const [id, basiObj] of Object.entries(basics as any) as any) {
					if (id == brain.user.id || !basiObj) continue;
					if (contView === 'users') splitStrgOrJoinArr(basiObj);
					else if (basiObj.ends) basiObj.ends = Number(basiObj.ends);
					const queueItem = contQueue.current[indexeMap.get(id)];
					if (!queueItem) continue;
					const existing = (brain[contView][id] = queueItem);
					Object.assign(existing, basiObj, { sync: Date.now(), state: contView === 'users' || existing.state !== 'Deta' ? 'basi' : 'basiDeta' });
					actualyReceivedIDs.add(id), itemsToStore.push(existing);
				}

				// HANDLE MISSES -------------------------------------------------
				// Steps: when server did not return an ID, either mark as del (if we had a usable snapshot) or schedule full deletion (if it was just a placeholder).
				for (const id of IDsToFetch.filter(id => !actualyReceivedIDs.has(id))) {
					const existing = brain[contView][id] || {};
					if (existing[contView === 'users' ? 'first' : 'title']) Object.assign(existing, { state: 'del' });
					else IDsToRemove.add(id);
				}
				await Promise.all([forage({ mode: 'set', what: contView, val: itemsToStore }), forage({ mode: 'del', what: contView, id: [...IDsToRemove] as any })]);
			}

			// SLICE + APPLY TO UI --------------------------------------------
			// Steps: filter out deletions, find the first unusable index, then append usable chunk to existing content when infinite; also handle scroll anchoring.
			let usableItems, firstUnusable;
			contQueue.current = contQueue.current.filter((item, i) => {
				if (item.id != brain.user.id && !usable(item) && firstUnusable === undefined) firstUnusable = i;
				return !IDsToRemove.has(item.id);
			});

			if (brain.canScroll) contentRef.current.scrollIntoView({ behavior: 'smooth' }), delete brain.canScroll;
			usableItems = contQueue.current.slice(0, firstUnusable);
			setCardsToContent([infinite ? content || [] : [], usableItems].flat());

			// SNAP FINALIZATION + HISTORY -------------------------------------
			// Steps: update map snapshot ids, update history only when snap is not "exact", clear snap.fetch flag, and persist user when we mutated unstable SQL or history.
			if (nowAt !== 'event' && show.view !== 'topEvents') {
				if (map === true) brain.lastFetchMapIDs = (brain.itemsOnMap || contQueue.current).map(item => item.id || item).sort((a, b) => a - b);
				else ['lastFetchMapIDs', 'snapChangedWhileMapHidden', 'stillShowingMapContent'].forEach(key => delete brain[key]);
				const lastSnap = provideSnap('last');
				if (lastSnap && typeof lastSnap === 'object') delete lastSnap.last;
				if (!provideSnap('exact'))
					brain.user.history.push({ ...trim(snap), types: snap.types.filter(type => avail.types.includes(type)), id: brain.user.history.length + 1, last: true }), (storeUser = true);
				else provideSnap('exact').last = true;
			}

			contQueue.current = contQueue.current.slice(firstUnusable || contQueue.current.length);
			if (!infinite) firstBatchReady.current = true;
			if (snap.fetch) setSnap(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => !['changed', 'fetch'].includes(key))));
			if (storeUser) forage({ mode: 'set', what: 'user', val: brain.user });
		} catch (err) {
			if (snap.fetch) setSnap(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => !['fetch'].includes(key))));
			if (import.meta.env.DEV) console.error('Content fetch error:', err);
		}
	}

	return { contQueue, disableInfinite, firstBatchReady, contentMan };
}
