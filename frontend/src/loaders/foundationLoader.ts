import { redirect } from 'react-router-dom';
import axios from 'axios';
import localforage from 'localforage';
import { forage, updateInteractions, delUndef, setPropsToContent, processMetas, splitStrgOrJoinArr, getDeviceFingerprint, getPDK } from '../../helpers';
import { emptyBrain } from '../../sources';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import { FOUNDATION_LOADS, INTERVALS } from '../../../shared/constants.ts';

// TODO could probably implement filter for non-user-cities events/users with sync thats not recent enough, to free up some space in the handleStaleContent
// TODO store citiesContSync individualy for each user
// TODO need to think through what happens if multiple users are logged in at the same time

let brain;
// SMALL HELPERS (BRAIN/URL/CITY) ----------------------------------------------
// Steps: keep tiny helpers as expressions to minimize callsite noise; these functions mostly gate early exits and normalize inputs before the heavy loader path runs.
const ensureBrainRef = brainParam => ((brain = brainParam || brain || { ...emptyBrain }), brain),
	parseUrlOverrides = url => (url ? Object.fromEntries(['newCities', 'homeView'].map(key => [key, new URL(url).searchParams.get(key)])) : { newCities: null, homeView: null }),
	createCityFinder = brain => city => brain.cities.find(c => (city.hashID ? city.hashID === c.hashID : (city.cityID || city) === c.cityID)),
	shouldSkipLoad = (path, params, brainRef) => (params.size && ['/entrance', '/setup'].some(str => path.startsWith(str))) || brainRef.user.isUnintroduced || (path !== '/' && brainRef.fastLoaded),
	handleMissingToken = (path, brainRef) => (path.startsWith('/event') ? brainRef : redirect('/entrance')),
	pruneCitySync = miscel => {
		if (miscel.citiesContSync) {
			const stamp = Date.now();
			for (const city of Object.keys(miscel.citiesContSync)) if (stamp - miscel.citiesContSync[city] > INTERVALS.cityContentRefresh) delete miscel.citiesContSync[city];
		}
		return miscel;
	};

// HYDRATE BRAIN FROM DEVICE ----------------------------------------------------
// Steps: load “miscel” from forage, prune stale city sync stamps, then assign into brainRef so the loader can decide incremental fetches; on failure, ensure initLoadData exists so later code doesn’t crash.
const hydrateFromDevice = async (brainRef, flags) => {
	// PRUNE STALE CITY SYNC ALWAYS ---
	// Steps: prune citiesContSync on every load to ensure stale timestamps don't prevent re-fetching content after extended idle periods.
	if (brainRef.citiesContSync) pruneCitySync(brainRef);

	if (brainRef.initLoadData && !flags.isInitOrRefreshLoad) return;
	flags.gotAuth = Boolean(brainRef.user.cities.length);
	try {
		const rawMiscel = await forage({ mode: 'get', what: 'miscel' });
		const miscel = pruneCitySync(rawMiscel || { initLoadData: {} });

		// Validate miscel structure before assigning
		if (!miscel || typeof miscel !== 'object') throw new Error('Invalid miscel data');

		Object.assign(brainRef, miscel);
		flags.isInitOrRefreshLoad = true;
	} catch (error) {
		console.warn('Failed to hydrate from device, starting fresh:', error);
		// Ensure basic structure exists even if hydration failed
		brainRef.initLoadData = brainRef.initLoadData || {};
	}
};

// BUILD AXIOS PLAN -------------------------------------------------------------
// Steps: decide foundation load mode based on route/homeView/newCities, compute which cities need cityData and which need contentMetas, then construct payload with epoch so backend can bind salts and deltas. devID comes from JWT via attachSession.
const buildAxiosPlan = ({ brainRef, path, meta, flags, findCity }) => {
	const plan: any = { citiesGetCityData: undefined, citiesGetContentMetas: [], axiosPayload: { load: FOUNDATION_LOADS.auth } };
	const { homeView, newCities, cities, lastDevSync, lastLinksSync, clientEpoch } = meta;
	if (homeView) brainRef.homeView = homeView;
	if (homeView === 'topEvents') ((plan.axiosPayload = { load: FOUNDATION_LOADS.topEvents, clientEpoch }), (plan.citiesGetContentMetas = ['topEvents']));
	else if (path.startsWith('/event')) plan.axiosPayload = { load: Date.now() - brainRef.user.initedAt > 60000 ? FOUNDATION_LOADS.fast : FOUNDATION_LOADS.auth, lastDevSync, lastLinksSync, clientEpoch };
	else if (path !== '/') plan.axiosPayload = { load: FOUNDATION_LOADS.auth, clientEpoch };
	else {
		(delete brainRef.fastLoaded, delete brainRef.isAfterLoginInit);
		plan.citiesGetCityData = cities?.filter(city => !findCity(city));
		plan.citiesGetContentMetas = cities?.filter(city => !brainRef.citiesContSync[city.cityID || city]).map(city => city.cityID || city) || [];
		plan.axiosPayload = plan.citiesGetContentMetas.length
			? delUndef({
					getCities: plan.citiesGetCityData,
					cities: plan.citiesGetContentMetas,
					lastDevSync,
					lastLinksSync,
					load: newCities ? FOUNDATION_LOADS.cities : FOUNDATION_LOADS.init,
					gotAuth: flags.gotAuth,
					clientEpoch,
				})
			: { load: FOUNDATION_LOADS.auth, clientEpoch };
	}
	return plan;
};

// FETCH FOUNDATION DATA --------------------------------------------------------
// Steps: POST `/foundation` and always return a plain object so the caller can treat missing fields as “auth-only”.
const fetchFoundationData = async (payload: any): Promise<any> => ((await axios.post('/foundation', payload as any)) as any)?.data || {};

// RESET GALLERY “NO MORE” ------------------------------------------------------
// Steps: clear per-mode “noMore” throttles after a cool-down so the user can fetch more items without manually reloading.
const resetGalleryNoMore = (brainRef, now) => {
	if (!(brainRef.user?.noMore?.gallery && brainRef.user?.galleryIDs)) return;
	for (const [mode, ts] of Object.entries(brainRef.user.noMore.gallery)) if (typeof ts === 'number' && now - ts > 600000) ((brainRef.user.galleryIDs[mode] = {}), delete brainRef.user.noMore.gallery[mode], brainRef.user.galleryOpenCounts && delete brainRef.user.galleryOpenCounts[mode]);
};

// RESET CHATS “NO MORE” --------------------------------------------------------
// Steps: clear short-lived chat throttles so chat lists can refill after a minute without hard reload.
const resetChatsNoMore = (brainRef, now) => {
	if (!brainRef.user?.noMore?.chats) return;
	for (const [key, ts] of Object.entries(brainRef.user.noMore.chats)) if (typeof ts === 'number' && now - ts > 60000) delete brainRef.user.noMore.chats[key];
};

// RESET TEMP DATA --------------------------------------------------------------
// Steps: clear volatile UI buckets (search/chatsList/invites) after time since init to keep device storage small and avoid showing stale results.
const resetTempData = async (brainRef, now) => {
	const tempData = {
		search: now - brainRef.user.initedAt > 300000,
		chatsList: now - brainRef.user.initedAt > 60000,
		invitesIn: now - brainRef.user.initedAt > 300000,
		invitesOut: now - brainRef.user.initedAt > 300000,
	};
	Object.keys(tempData).forEach(key => {
		if (!tempData[key]) return;
		if (Array.isArray(brainRef.user[key])) brainRef.user[key] = [];
		else if (typeof brainRef.user[key] === 'object') brainRef.user[key] = {};
	});
};

// UNSTABLE DEVICE HANDLING -----------------------------------------------------
// Steps: if unstableDev, keep sync markers under unstableObj; when stability returns, drop unstableObj and restore stable sync pointers.
const handleUnstableDev = (brainRef, { unstableDev, devSync, linksSync }) => {
	if (!unstableDev && !brainRef.user.unstableObj) brainRef.user.devSync = devSync;
	else if (unstableDev) {
		const unstable = (brainRef.user.unstableObj ??= { gotSQL: { events: [], users: [] } });
		if (typeof linksSync === 'number') unstable.linksSync = linksSync;
	} else if (!unstableDev && brainRef.user.unstableObj) (delete brainRef.user.unstableObj, (brainRef.user.devSync = brainRef.initLoadData.lastDevSync), delete brainRef.initLoadData.lastLinksSync);
};

// APPLY AUTH + USER ------------------------------------------------------------
// Steps: when backend sends auth, persist it via forage worker (bind to print + PDK/pdkSalt/DEK), rehydrate miscel if needed (refresh flow), then merge user+notifDots and update interactions.
const applyAuthAndUser = async (ctx, data) => {
	const { brainRef, meta } = ctx;
	const { auth, authEpoch, authExpiry, previousAuth, deviceSalt, deviceKey, pdkSalt, user, notifDots, devSync, linksSync, interactions, delInteractions, unstableDev = null } = data;

	// AUTH ROTATION / LOGIN HANDLING ---
	if (auth) {
		const [userID, authHash] = auth.split(':');
		brainRef.user.id = userID;

		// Store auth - worker loads PDK/DEK from encrypted IndexedDB (or uses provided keys on login) ---------------------------
		const print = getDeviceFingerprint();
		const pdk = getPDK(); // Only present during login flow
		try {
			await forage({
				mode: 'set',
				what: 'auth',
				val: authEpoch !== undefined ? { auth, print, ...(pdk && { pdk }), ...(pdkSalt && { pdkSalt }), ...(deviceSalt && { deviceSalt }), deviceKey, epoch: authEpoch, prevAuth: previousAuth } : authHash,
				id: userID,
			});
		} catch (e: any) {
			if (e.message === 'fingerprintChanged') {
				window.__showRekeyModal?.();
				return 'awaiting_rekey';
			}
			if (e.message === 'noPDK' || e.message === 'noPdkSalt') return 'session_expired';
			throw e;
		}

		// DEK now available - reload miscel if it wasn't loaded before (refresh flow) ---------------------------
		if (!brainRef.initLoadData?.cities) {
			const miscel = pruneCitySync((await forage({ mode: 'get', what: 'miscel' })) || {});
			if (miscel.initLoadData) (Object.assign(brainRef, miscel), (meta.cities = miscel.initLoadData.cities), (meta.lastDevSync = miscel.initLoadData.lastDevSync), (meta.lastLinksSync = miscel.initLoadData.lastLinksSync));
		}

		if (authExpiry) brainRef.authExpiry = authExpiry;
	} else {
		delete brainRef.isAfterLoginInit;
	}

	// APPLY USER DATA AND WATERMARKS ---
	const forageUser = (await forage({ mode: 'get', what: 'user' })) || {};
	const forageAlerts = (await forage({ mode: 'get', what: 'alerts' })) || {};
	const incomingUser = splitStrgOrJoinArr(user || {}, 'split');

	Object.assign(brainRef, {
		initLoadData: { cities: user?.cities || meta.cities, lastDevSync: devSync ?? meta.lastDevSync, lastLinksSync: linksSync ?? meta.lastLinksSync },
		user: Object.assign(brainRef.user, forageUser, incomingUser, {
			alerts: { ...forageAlerts, ...(notifDots && { notifDots }) },
			lastSeenAlert: notifDots?.lastSeenAlert || 0,
		}),
	});

	// RESET THROTTLES AND INTERACTION DELTAS ---
	(resetGalleryNoMore(brainRef, meta.now), resetChatsNoMore(brainRef, meta.now), await resetTempData(brainRef, meta.now), handleUnstableDev(brainRef, { unstableDev, devSync, linksSync }));
	updateInteractions({ brain: brainRef, add: interactions, del: delInteractions });
	return true;
};

// HYDRATE PREVIOUS CONTENT -----------------------------------------------------
// Steps: when backend returned auth-only (or partial cities), pull previously loaded IDs from device and hydrate events/users so UI has something to render immediately.
const hydratePrevContent = async (ctx, data) => {
	const { brainRef, plan, meta, isFastLoad } = ctx;
	const { contentMetas } = data;

	if (isFastLoad || !brainRef.user.prevLoadedContIDs || (contentMetas && meta.cities?.length === plan.citiesGetContentMetas?.length)) return;
	if (contentMetas && plan.citiesGetContentMetas.length) plan.citiesGetContentMetas.forEach(city => delete brainRef.user.prevLoadedContIDs[city]);

	// GUARD AGAINST MISSING PREVLOADEDCONTIDS ---
	// Steps: ensure prevLoadedContIDs exists before accessing keys to prevent undefined access errors on new/corrupted storage.
	const prevLoadedContIDs = brainRef.user.prevLoadedContIDs || {};
	// If contentMetas is undefined (auth-only response), load ALL stored cities; otherwise load only unfetched ones ---------------------------
	const citiesToLoad = !contentMetas
		? Object.keys(prevLoadedContIDs).filter(k => k !== 'topEvents') // Load all stored cities when no content from backend
		: meta.cities?.filter(city => !plan.citiesGetContentMetas?.includes(city)) || []; // Load only cities not fetched this request

	const freshAndNotFetched = [...citiesToLoad, ...(meta.homeView !== 'topEvents' && prevLoadedContIDs.topEvents ? ['topEvents'] : [])];
	for (const city of freshAndNotFetched.filter(city => Boolean(prevLoadedContIDs[city]))) {
		const prevIDs = prevLoadedContIDs[city];
		const eveIDs = Array.isArray(prevIDs.events) ? prevIDs.events : [...(prevIDs.events || [])];
		const useIDs = Array.isArray(prevIDs.users) ? prevIDs.users : [...(prevIDs.users || [])];
		if (!eveIDs.length && !useIDs.length) continue;
		const [eventsToLoad, usersToLoad = []] = await Promise.all([eveIDs.length ? forage({ mode: 'get', what: 'events', id: eveIDs }) : [], ...(meta.homeView !== 'topEvents' && useIDs.length ? [forage({ mode: 'get', what: 'users', id: useIDs })] : [])]);

		for (const event of eventsToLoad || []) brainRef.events[event.id] = Object.assign(brainRef.events[event.id] || {}, event);
		for (const user of usersToLoad || []) brainRef.users[user.id] = Object.assign(brainRef.users[user.id] || {}, user);
	}
};

// ENSURE LOCATION --------------------------------------------------------------
// Steps: best-effort geolocation read with short timeout; store result into user so distance-based UX can work without repeated prompts.
const ensureLocation = async brainRef => {
	try {
		if (!('geolocation' in navigator)) return;
		const position: any = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 3000, maximumAge: 60000 }));
		const { latitude, longitude } = position?.coords || {};
		if (typeof latitude === 'number' && typeof longitude === 'number') ((brainRef.user.location = [latitude, longitude]), await forage({ mode: 'set', what: 'user', val: brainRef.user }));
	} catch {
		brainRef.user.locationDenied = true;
	}
};

// ENSURE LOCATION IF NEEDED ----------------------------------------------------
// Steps: only prompt/compute when location is missing so we don’t nag or re-request on every load.
const ensureLocationIfNeeded = async brainRef => {
	if (!Array.isArray(brainRef?.user?.location) || brainRef.user.location.length !== 2) await ensureLocation(brainRef);
};

// STORE CITIES + CONTENT -------------------------------------------------------
// Steps: merge citiesData into brain, compute curCities ids, process content metas into brain maps, then persist only the received event/user subsets to forage so storage stays proportional.
const storeCitiesAndContent = async (ctx, data) => {
	const { brainRef, plan, meta, findCity } = ctx;
	const { citiesData, contentMetas, contSync } = data;
	if (ctx.isFastLoad) return;
	if (citiesData) citiesData.forEach(city => brainRef.cities.push(city));
	if (meta.cities) brainRef.user.curCities = meta.cities.map(city => city.cityID || findCity(city)?.cityID || 1).sort((a, b) => a - b);
	if (!contentMetas) return;
	const receivedEventIDs = new Set();
	const receivedUserIDs = new Set();
	if (meta.homeView !== 'topEvents') {
		const contentCityIDs = plan.citiesGetContentMetas.map(city => findCity(city)?.cityID);
		for (const city of contentCityIDs) (delete brainRef.meetStats[city], delete brainRef.citiesEveTypesInTimes[city], delete brainRef.user.prevLoadedContIDs[city]);
		await Promise.allSettled(
			(contentMetas || []).map(async city => {
				const eveMetas = { cityID: city.cityID };
				const userMetas = { cityID: city.cityID };
				brainRef.citiesContSync[city.cityID] = meta.now;
				if (!city.error) ['cityID', 'error'].forEach(key => delete city[key]);
				if (Object.keys(city).length === 0 || city.error) return;
				for (const [id, metaVal] of Object.entries(city as any) as any) (Array.isArray((metaVal as any)?.[(metaVal as any)?.length - 1]) ? (receivedUserIDs.add(id), userMetas) : (receivedEventIDs.add(id), eveMetas))[id] = metaVal;
				await processMetas({ eveMetas, userMetas, brain: brainRef, contSync, isNewContent: true });
			})
		);
	} else (await processMetas({ eveMetas: contentMetas[0], brain: brainRef, contSync, isNewContent: true }), Object.keys(contentMetas[0]).forEach(id => receivedEventIDs.add(id)));
	await Promise.all([forage({ mode: 'set', what: 'events', val: (Object.values(brainRef.events) as any[]).filter(event => receivedEventIDs.has(event.id)) }), forage({ mode: 'set', what: 'users', val: (Object.values(brainRef.users) as any[]).filter(user => receivedUserIDs.has(user.id)) })]);
};

// HYDRATE FOCUSED EVENT (FAST LOAD) -------------------------------------------
// Steps: when fast-loading an event route, hydrate that one event from device so the Event page can render before full foundation hydration finishes.
const hydrateFocusedEvent = async ctx => {
	const { path, brainRef } = ctx;
	if (!ctx.isFastLoad || !path.startsWith('/event/')) return;
	const eventID = path.replace('/event/', '').split('!', 1)[0];
	if (eventID) brainRef.events[eventID] ??= (await forage({ mode: 'get', what: 'eve', id: eventID })) || (brainRef.user.id && (await forage({ mode: 'get', what: 'past', id: eventID }))) || {};
};

// HANDLE STALE CONTENT ---------------------------------------------------------
// Steps: mark items stale or delete based on sync windows, persist past events into `past` store, delete orphaned comms, and prune interaction arrays so storage doesn’t bloat.
const handleStaleContent = async (ctx, data) => {
	const { brainRef, plan, meta } = ctx;
	const { contentMetas, contSync } = data;
	if (!contentMetas || !plan?.citiesGetContentMetas?.length || meta.homeView === 'topEvents') return;
	const bestOfIDsSet = new Set(brainRef.bestOfIDs || []);
	const delEve = new Set<any>();
	const delUse = new Set<any>();
	const [sixMonthsAgo, threeMonthsAgo, monthAgo] = [-6, -3, -1].map(monthsOffset => new Date(new Date().setUTCMonth(new Date().getUTCMonth() + monthsOffset)).getTime());
	const twoYearsInMs = 365 * 24 * 60 * 60 * 1000 * 2;

	for (const arrKey of ['events', 'users']) {
		const allowedStates = new Set(['meta', 'basi', 'basiDeta', 'mini']);
		const deletionIDs = arrKey === 'events' ? delEve : delUse;
		for (const obj of Object.values(brainRef[arrKey]) as any[]) {
			const { sync, starts, ends, type, id, cityID, state, own, inter, mark } = obj as any;
			if (sync === contSync) {
				if (sync >= (ends || starts) && (ends || starts) < Date.now() && allowedStates.has(state) && (own || ['sur', 'may'].includes(inter))) {
					const attendees = (Object.values(brainRef.users) as any[]).filter(user => (user as any)?.eveInters?.some?.(([eveID]) => eveID === id));
					(deletionIDs.add(id), delete brainRef.user.eveUserIDs?.[id]);
					await forage({ mode: 'set', what: 'past', id, val: Object.assign(obj, { ...(type.startsWith('a') && { pastUsers: attendees }) }) });
				}
			} else if (allowedStates.has(state)) {
				const syncDate = new Date(sync);
				if (arrKey === 'events') {
					if (bestOfIDsSet.has(id) ? new Date().getUTCDate() !== syncDate.getUTCDate() : !brainRef.citiesContSync[cityID]) obj.state = 'stale';
				} else if (arrKey === 'users') {
					if (obj.eveInters && (obj.eveInters = obj.eveInters.filter(([eveID]) => allowedStates.has(brainRef.events[eveID]?.state))).length === 0) obj.state = 'stale';
				}
			}
			const delConds = {
				basi: (ends || starts) < meta.now && sync > (ends || starts) && sync < Date.now() - 1000 * 60 * 60 * 24 * 30,
				basiDeta: (ends || starts) < meta.now && sync > (ends || starts) && sync < Date.now() - 1000 * 60 * 60 * 24 * 30,
				stale: !inter && !mark && (bestOfIDsSet.has(id) ? sync < monthAgo : sync < threeMonthsAgo),
				mini: meta.now - brainRef.user.initedAt > 900000,
				del: true,
			};
			if (delConds[obj.state] || sync < sixMonthsAgo) deletionIDs.add(id);
		}

		if (!deletionIDs.size) continue;
		(delete brainRef.scrollTo, delete brainRef.citiesLoadData);
		await forage({ mode: 'del', what: arrKey, id: [...deletionIDs] as any });
		const commentsToDel = new Set();
		const nowStamp = Date.now();
		const interactionArrs = arrKey === 'events' ? ['eveInters', 'rateEve', 'rateComm'] : ['linkUsers', 'rateUsers'];
		const usersToClean = [brainRef.user, brainRef.user.unstableObj].filter(Boolean);

		if (arrKey === 'events') {
			for (const id of [...deletionIDs] as any[]) {
				const commsPayload = (brainRef.events as any)?.[id]?.commsData || (await forage({ mode: 'get', what: 'comms', id: id as any }))?.commsData || [];
				for (const comment of commsPayload) {
					for (const reply of comment.repliesData || []) commentsToDel.add(reply.id);
					commentsToDel.add(comment.id);
				}
				await forage({ mode: 'del', what: 'comms', id: id as any });
				(bestOfIDsSet.delete(id), delete brainRef.user.eveUserIDs?.[id], delete brainRef.user.invites?.[id]);
				delete brainRef[arrKey][id];
			}
		} else for (const id of [...deletionIDs] as any[]) delete brainRef[arrKey][id];

		const cleanSearchResults = userObj => {
			if (!userObj?.search) return;
			Object.keys(userObj.search).forEach(key => {
				const bucket = userObj.search[key];
				if (!bucket?.[arrKey]) return;
				bucket[arrKey] = Object.fromEntries(Object.entries(bucket[arrKey] as any).map(([subKey, results]) => [subKey, (results as any[])?.filter(e => !deletionIDs.has((e as any).id))]));
			});
		};

		for (const userObj of usersToClean) {
			if (userObj === brainRef.user.unstableObj) {
				if (userObj.gotSQL?.[arrKey]) userObj.gotSQL[arrKey] = userObj.gotSQL[arrKey].filter(id => !deletionIDs.has(id));
				continue;
			}
			cleanSearchResults(userObj);
		}

		usersToClean.forEach(userObj => {
			interactionArrs
				.filter(arr => userObj?.[arr])
				.forEach(arr => {
					userObj[arr] = userObj[arr].filter(item => {
						if (arr === 'rateComm') return commentsToDel.has(item[0]);
						const id = Array.isArray(item) ? item[0] : item;
						if (deletionIDs.has(id)) return false;
						if (arr === 'events' && !brainRef.events[id]) {
							const base36Timestamp = id.slice(0, 4);
							const eventDayTimestamp = parseInt(base36Timestamp, 36) * 86400000;
							return Math.max(eventDayTimestamp, item.starts) + twoYearsInMs < nowStamp;
						}
						return true;
					});
				});
		});
	}
};

// PERSIST TO DEVICE ------------------------------------------------------------
// Steps: persist only the buckets touched by this load (user/miscel) so we don’t rewrite huge payloads unnecessarily; “miscel” is written for init/refresh/topEvents/city changes.
const persistToDevice = async (ctx, data) => {
	const { brainRef, flags, meta } = ctx;
	const { interactions, delInteractions, user, contentMetas, citiesData } = data;
	const keys = [];
	if (flags.isInitOrRefreshLoad) brainRef.user.initedAt = meta.now;
	const miscelVal = {};
	if (interactions || delInteractions || user || contentMetas) keys.push('user');
	if (flags.isInitOrRefreshLoad || meta.homeView === 'topEvents' || citiesData) (keys.push('miscel'), ['cities', 'initLoadData', 'bestOfIDs', 'meetStats', 'citiesEveTypesInTimes', 'citiesContSync'].forEach(key => brainRef[key] && (miscelVal[key] = brainRef[key])));
	await Promise.all(keys.map(async key => forage({ mode: 'set', what: key, val: key === 'miscel' ? miscelVal : brainRef[key] })));
};

// LOAD FOUNDATION DATA ---------------------------------------------------------
// Steps: hydrate brain from device, decide incremental fetch plan, fetch foundation payload, apply auth/user, hydrate cached content, ensure location, process metas/content, prune stale content, then persist updated state back to device.
export async function foundationLoader({ url, isFastLoad = false, brain: brainParam }: any = {}) {
	// PARAM TYPES OVERRIDE ---------------------------------------------------------
	// Steps: treat loader args as dynamic (router supplies varying shapes); keep runtime behavior but prevent `{}`-typed destructuring from cascading.
	const brainRef: any = ensureBrainRef(brainParam);
	try {
		const [path, token, urlParams] = [window.location.pathname, await forage({ mode: 'get', what: 'token' }), new URLSearchParams(window.location.search)];
		if (shouldSkipLoad(path, urlParams, brainRef)) return brainRef;
		if (!token && !brainRef.isAfterLoginInit) return handleMissingToken(path, brainRef); // Skip token check right after login

		const ctx: any = { brainRef, isFastLoad, path, urlParams, flags: {}, plan: {}, meta: {}, findCity: null };
		await hydrateFromDevice(brainRef, ctx.flags as any);
		ctx.findCity = createCityFinder(brainRef);
		const { newCities, homeView } = parseUrlOverrides(url);
		const base: any = newCities ? { cities: JSON.parse(decodeURIComponent(newCities)) } : brainRef.initLoadData || brainRef.user;
		const { cities, lastDevSync, lastLinksSync } = base || {};
		const clientEpoch = await localforage.getItem('authEpoch');
		ctx.meta = { newCities, homeView, cities, lastDevSync, lastLinksSync, clientEpoch, now: Date.now() } as any;
		ctx.plan = buildAxiosPlan({ brainRef, path, meta: ctx.meta, flags: ctx.flags, findCity: ctx.findCity }) as any;
		const foundationData = await fetchFoundationData((ctx.plan as any).axiosPayload);

		const authResult = await applyAuthAndUser(ctx, foundationData);
		if (authResult === 'session_expired') return redirect(`/entrance?mess=sessionExpired&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
		if (authResult === 'awaiting_rekey') return brainRef;
		if (authResult) await hydratePrevContent(ctx, foundationData);
		await ensureLocationIfNeeded(brainRef);
		await storeCitiesAndContent(ctx, foundationData);
		await hydrateFocusedEvent(ctx);
		await handleStaleContent(ctx, foundationData);
		(setPropsToContent('events', brainRef.events, brainRef, true), setPropsToContent('users', brainRef.users, brainRef, true));
		await persistToDevice(ctx, foundationData);
		return brainRef;
	} catch (error: any) {
		notifyGlobalError(error, 'Nepodařilo se načíst data aplikace.');
		return brainRef;
	}
}
