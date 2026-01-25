import axios from 'axios';
import { EVENT_META_INDEXES, USER_META_INDEXES, USER_BASI_KEYS, EVENT_BASICS_KEYS, EVENT_DETAILS_KEYS } from '../shared/constants';
const eveBasiKeys = [...EVENT_BASICS_KEYS, 'city', 'basiVers'];
const eveDetailsKeys = [...EVENT_DETAILS_KEYS, 'detaVers'];
import { getDistance } from './src/utils/locationUtils';
import { disconnectSocketIO } from './src/hooks/useSocketIO';

// GEOHASH DECODE (NO CDN/DEPS) ---------------------------------------------------------------------------
// Decodes geohash to the center-point lat/lon; we only need this for distance/map UI.
function decodeGeohashToLatitudeLongitude(geohashString) {
	// INPUT GUARD ---------------------------------------------------------------------------
	if (!geohashString || typeof geohashString !== 'string') return {};

	// BASE32 MAP ---------------------------------------------------------------------------
	const base32Chars = '0123456789bcdefghjkmnpqrstuvwxyz';
	let [isEvenBit, latitudeRange, longitudeRange] = [true, [-90, 90], [-180, 180]];

	// RANGE REFINEMENT ---------------------------------------------------------------------------
	for (const geohashCharacter of geohashString.toLowerCase()) {
		const characterIndex = base32Chars.indexOf(geohashCharacter);
		if (characterIndex === -1) return {};
		for (let bitIndex = 4; bitIndex >= 0; bitIndex--) {
			const bitIsSet = (characterIndex >> bitIndex) & 1;
			const [rangeMin, rangeMax] = isEvenBit ? longitudeRange : latitudeRange;
			const rangeMid = (rangeMin + rangeMax) / 2;
			if (bitIsSet) isEvenBit ? (longitudeRange[0] = rangeMid) : (latitudeRange[0] = rangeMid);
			else isEvenBit ? (longitudeRange[1] = rangeMid) : (latitudeRange[1] = rangeMid);
			isEvenBit = !isEvenBit;
		}
	}

	// CENTERPOINT OUTPUT ---------------------------------------------------------------------------
	return { lat: (latitudeRange[0] + latitudeRange[1]) / 2, lon: (longitudeRange[0] + longitudeRange[1]) / 2 };
}

const { evePrivIdx, eveOwnerIdx, eveCityIDIdx, eveTypeIdx, eveStartsIdx, eveGeohashIdx, eveSurelyIdx, eveMaybeIdx, eveCommentsIdx, eveScoreIdx, eveBasiVersIdx, eveDetailsVersIdx } = EVENT_META_INDEXES;
const { userPrivIdx, userAgeIdx, userGenderIdx, userIndisIdx, userBasicsIdx, userTraitsIdx, userScoreIdx, userImgVersIdx, userBasiVersIdx, userAttendIdx } = USER_META_INDEXES;
// TODO implement ends of events into metas (big task)

// INFO if users create a friendly meeting, he shouldd be able to chhoose between surely / maybe attendance, AND this attendance should be inicated on the cardd / event as long as there is no user having th surely attenance. otherwise it wouldn´t be apparernt which friendlyMeetings are serius and which ones are "lets see what happens"

export function createSubsetObj(obj, props) {
	const newObj = {};
	props.forEach(prop => (newObj[prop] = obj[prop]));
	return newObj;
}

// GET TIME-FRAMES ---------------------------------------------------------------------------
export function getTimeFrames(name: string | null = null) {
	const dayTs = (base, h = 0, d = 0) => {
		const dt = new Date(base);
		dt.setDate(dt.getDate() + d);
		dt.setHours(h, h ? 23 : 0, h ? 59 : 0, h ? 999 : 0);
		return dt.getTime();
	};

	const rangeTs = (base, type) => {
		const d = base.getDay();
		const start = dayTs(base, 0, type === 'weekend' ? (d === 6 ? 0 : 6 - d) : d === 0 ? -6 : 1 - d);
		return { start, end: dayTs(start, 23, type === 'weekend' ? 1 : 6) };
	};

	const now = Date.now(),
		today = dayTs(now),
		tomorrow = dayTs(now, 0, 1),
		weekend = rangeTs(new Date(today), 'weekend'),
		week = rangeTs(new Date(today), 'week'),
		nextWeek = rangeTs(new Date(dayTs(today, 0, 7)), 'week'),
		mEnd = dayTs(today, 23, 30),
		nMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 0);

	const frames = {
		anytime: { name: 'anytime', start: 0, end: Infinity },
		recent: { name: 'recent', start: 0, end: now },
		today: { name: 'today', start: today, end: dayTs(now, 23) },
		tomorrow: { name: 'tomorrow', start: tomorrow, end: dayTs(tomorrow, 23) },
		weekend: { name: 'weekend', start: weekend.start, end: weekend.end },
		week: { name: 'week', start: week.start, end: week.end },
		nextWeek: { name: 'nextWeek', start: nextWeek.start, end: nextWeek.end },
		month: { name: 'month', start: today, end: mEnd },
		twoMonths: { name: 'twoMonths', start: today, end: dayTs(nMonth) },
	};

	return name ? frames[name] || {} : frames;
}

// GET EVENT RANK ---------------------------------------------------------------------------
export const getEventRank = event => 3 * event.surely + event.maybe + 0.2 * event.score;
export async function logoutAndCleanUp(brain, emptyBrain, logOut = false) {
	try {
		// DISCONNECT AND CLEAR SESSION ---
		disconnectSocketIO();
		sessionStorage.clear();
		localStorage.clear();
		clearPDK();

		// PRUNE STORAGE AND WORKERS ---
		// PDK and DEK are cleared from workers and IndexedDB; full device wipe initiated.
		await forage({ mode: 'del', what: 'everything' });

		// RESET BRAIN ---
		if (brain) {
			Object.keys(brain).forEach(key => delete brain[key]);
			Object.assign(brain, emptyBrain);
		}
		if (logOut) window.location.href = '/entrance';
	} catch (error) {
		console.error('Error during brain cleanup:', error);
		return false;
	}
}

// CONTENT METAS PROCESS ---------------------------------------------------------------------------
export async function processMetas({ eveMetas = {}, userMetas = {}, brain, contSync, isNewContent = false }: any) {
	try {
		const delProps = (obj, keys) => keys.forEach(key => delete obj[key]);
		const splitNum = str => str?.split(',').map(Number) || [];

		const timeFramesObj = (getTimeFrames as any)();
		const setMeetStats = (cityID, type) => ((brain.meetStats[cityID] ??= {}), (brain.meetStats[cityID][type] ??= { events: 0, people: 0 }));
		const thisCity = eveMetas.cityID || userMetas.cityID;
		(delete eveMetas.cityID, delete userMetas.cityID);

		const [userIDs, eventIDs] = [new Set(Object.keys(userMetas).filter(id => !brain.users[id])), new Set(Object.keys(eveMetas).filter(id => !brain.events[id]))];
		const bestOfIDsSet = brain.homeView === 'topEvents' ? new Set(brain.bestOfIDs) : null;

		for (const what of ['events', 'users']) for (const item of (await forage({ mode: 'get', what, id: [...(what === 'events' ? eventIDs : userIDs)] })) as any[]) brain[what][item.id] = item;
		const typesInTimes: any = Object.keys(timeFramesObj).reduce((acc, frame) => ((acc[frame] = new Set()), acc), {} as any);
		if (isNewContent) brain.user.prevLoadedContIDs[thisCity] = { events: [], users: [] }; // Arrays for JSON serialization

		// EVENT METAS PROCESSING ---------------------------------------------------------------------------
		for (const [id, meta] of Object.entries(eveMetas)) {
			const [priv, owner, cityID, type, starts, geohash, surely, maybe, comments, score, basiVers, detaVers] = [meta[evePrivIdx], meta[eveOwnerIdx], meta[eveCityIDIdx], meta[eveTypeIdx], meta[eveStartsIdx], meta[eveGeohashIdx], meta[eveSurelyIdx] || 0, meta[eveMaybeIdx] || 0, meta[eveCommentsIdx] || 0, meta[eveScoreIdx] || 0, meta[eveBasiVersIdx], meta[eveDetailsVersIdx]];
			const convStarts = parseInt(starts, 36);

			// POPULATE BEST-OF-IDS OR AVAIL TIMEFRAMES -----------------------------------------------
			if (bestOfIDsSet) bestOfIDsSet.add(id);
			else if (isNewContent) {
				if (type.startsWith('a')) setMeetStats(cityID, type).events++;
				brain.user.prevLoadedContIDs[thisCity].events.push(id);
				for (const frame of Object.keys(timeFramesObj)) {
					const { start, end } = timeFramesObj[frame];
					if (convStarts >= start && convStarts <= end) typesInTimes[frame].add(type);
				}
			}

			// CREATE EVENT OBJECT ----------------------------------------------------------------
			const event = brain.events[id];
			const { lat, lon } = geohash?.length === 9 ? decodeGeohashToLatitudeLongitude(geohash) : {};
			const [ulat, ulng] = Array.isArray(brain.user.location) ? brain.user.location : [];
			const hasUserLocation = Number.isFinite(ulat) && Number.isFinite(ulng);
			const hasEventLocation = Number.isFinite(lat) && Number.isFinite(lon);
			const distance = hasUserLocation && hasEventLocation ? getDistance(ulat, ulng, lat, lon) : null;
			const eventObj = {
				id: id,
				sync: contSync,
				starts: convStarts,
				...(distance !== null ? { distance } : {}),
				state: event && ['basi', 'basiDeta', 'mini'].includes(event.state) ? event.state : 'meta',
				rank: getEventRank({ surely: Number(surely), maybe: Number(maybe), score: Number(score) }),
				owner: owner === 'orphaned' ? null : owner,
				priv,
				cityID,
				type,
				lat,
				lng: lon,
				surely: Number(surely),
				maybe: Number(maybe),
				score: Number(score),
				comments,
			};

			// MERGE WITH EXISTING EVENT OR CREATE NEW ---------------------------------------------------------------------
			if (event) {
				if (detaVers != (event.detaVers || detaVers)) (delProps(event, eveDetailsKeys), (event.state = 'basi'), delete event.detaVers);
				if (basiVers != (event.basiVers || basiVers)) (delProps(event, eveBasiKeys), (event.state = event.state === 'basiDeta' ? 'Deta' : 'meta'), delete event.basiVers);
				Object.assign(event, eventObj);
			} else brain.events[id] = eventObj;
		}

		// USER METAS PROCESSING -------------------------------------------------------------------------
		for (const [id, meta] of Object.entries(userMetas)) {
			const [priv, age, gender, indis, basics, traits, score, imgVers, basiVers, attend] = [meta[userPrivIdx], meta[userAgeIdx], meta[userGenderIdx], meta[userIndisIdx] || '', meta[userBasicsIdx] || '', meta[userTraitsIdx] || '', meta[userScoreIdx], meta[userImgVersIdx], meta[userBasiVersIdx], meta[userAttendIdx] || []];
			if (id == brain.user.id) continue;

			// CREATE USER OBJECT ----------------------------------------------------------------
			const [user, attenIDsSet] = [brain.users[id], new Set(attend.map(([eveID]) => eveID))];
			const eveInters = [...attend.map(arr => arr.slice(0, 2)).filter(([eveID]) => brain.events[eveID]), ...(user?.eveInters || []).filter(([eveID]) => !attenIDsSet.has(eveID))];

			// UPDATE MEETSTATS FOR USERS' ATTENDANCE WHEN NEW CONTENT ARRIVES -----------------------------
			if (isNewContent) {
				brain.user.prevLoadedContIDs[thisCity].users.push(id);

				for (const [eveID] of attend) {
					const ev = brain.events[eveID];
					if (ev && ev.type.startsWith('a')) setMeetStats(ev.cityID, ev.type).people++;
				}
			}
			const userObj = {
				id: id,
				sync: contSync,
				state: user && user.state === 'basi' ? user.state : 'meta',
				traits: traits?.split(',') || [],
				sortProps: {},
				basics: splitNum(basics),
				indis: splitNum(indis),
				score: Number(score),
				age,
				priv,
				gender,
				imgVers: Number(imgVers),
				eveInters,
			};

			// MERGE WITH EXISTING USER OR CREATE NEW ---------------------------------------------------------------------
			if (user) {
				if (basiVers != (user.basiVers || basiVers)) (delProps(user, USER_BASI_KEYS), (user.state = 'meta'), delete user.basiVers);
				Object.assign(user, userObj);
			} else brain.users[id] = userObj;
		}

		// CONVERT SETS TO ARRAYS ----------------------------------------------------------------------
		if (bestOfIDsSet) brain.bestOfIDs = [...bestOfIDsSet];
		if (isNewContent) !bestOfIDsSet && (brain.citiesEveTypesInTimes[thisCity] = Object.fromEntries(Object.entries(typesInTimes).map(([frame, types]: any[]) => [frame, Array.from(types as any)])));
	} catch (error) {
		console.error('PROCESS METAS ERROR', error);
		throw error;
	}
}

// UPDATE INTERACTIONS ---------------------------------------------------------------
// INFO should probably delete openEve regularly
export function updateInteractions({ brain, add, del }: { brain: any; add?: any; del?: any }) {
	const [targetObj, now] = [brain.user.unstableObj || brain.user, Date.now()];
	const keys = ['eveInters', 'rateEve', 'rateComm', 'rateUsers', 'linkUsers', 'openEve'];
	(keys.forEach(key => (targetObj[key] ??= [])), brain.user.unstableObj && ['events', 'users'].forEach(key => (brain.user.unstableObj.gotSQL[key] ??= [])));

	//  UPDATE OR ADD INTERACTIONS --------------------------------------------------
	function updaOrAdd(key, targetArr) {
		const fastLookupMap = new Map(targetArr.map((item, i) => [item[0], [item, i]]));

		/** event interests */
		if (key === 'eveInters') {
			for (const att of Object.keys(add[key])) {
				for (const item of add[key][att]) {
					const [, , interPriv] = item;
					const final = [item[0], att, interPriv ?? item[1]];
					const i = fastLookupMap.get(final[0])?.[1];
					i === undefined ? targetArr.push(final) : (targetArr[i] = final);
				}
			}
			/** linked users */
		} else if (key === 'linkUsers') {
			for (const item of add[key]) {
				const i = fastLookupMap.get(item[0])?.[1];
				i === undefined ? targetArr.push(item) : (targetArr[i] = item);
			}
		} else {
			/** content ratings */
			for (const item of add[key]) {
				const i = fastLookupMap.get(item[0])?.[1];
				i === undefined ? targetArr.push(key !== 'rateComm' ? item : [...item, now]) : (targetArr[i] = item);
			}
		}
	}

	if (add) {
		// NORMALIZE LINK USERS ARRAY (FIRST UNSTABLE INIT) AND THEN PROCESS UPDATES ------------------
		if (brain.user.unstableObj && Array.isArray(add.linkUsers) && add.linkUsers.length && !Array.isArray(add.linkUsers[0])) {
			const normalizedLinkUsers = add.linkUsers.map(user => (Array.isArray(user) ? user : [user]));
			targetObj.linkUsers = normalizedLinkUsers.map(item => [...item]);
			add.linkUsers = normalizedLinkUsers;
		}
		keys.filter(key => add[key]).forEach(key => updaOrAdd(key, targetObj[key]));
	}
	if (del) {
		['eveInters', 'rateEve', 'rateComm', 'rateUsers', 'linkUsers']
			.filter(key => del[key])
			.forEach(key => {
				const delSet = new Set(del[key]);
				targetObj[key] = targetObj[key].filter(item => !delSet.has(item[0] || item));
			});
	}
}

// GET DEVICE FINGER PRINT --------------------------------------------------------------------
// Uses only highly stable signals that rarely change. Avoids: userAgent (browser updates), screen dimensions (external monitors),
// devicePixelRatio (display settings), timezoneOffset (DST changes twice/year).
export function getDeviceFingerprint() {
	const nav = navigator as any,
		screen = window.screen;
	const data = [
		// HARDWARE SIGNALS
		nav.hardwareConcurrency || 4, // CPU cores
		nav.deviceMemory || 8, // RAM in GB (Chrome/Edge only, falls back)
		nav.maxTouchPoints || 0, // Touch hardware capability
		nav.platform || '', // OS platform (Win32, MacIntel, Linux x86_64)
		// DISPLAY SIGNALS
		screen.colorDepth || 24, // Display color depth
		// LOCALE SIGNALS
		Intl.DateTimeFormat().resolvedOptions().timeZone || '', // Timezone name (not offset)
		nav.language || '', // Primary browser language
		nav.languages?.join(',') || '', // All preferred languages
		// BROWSER CAPABILITY SIGNALS
		typeof nav.pdfViewerEnabled !== 'undefined' ? nav.pdfViewerEnabled : '', // PDF viewer built-in
		typeof nav.cookieEnabled !== 'undefined' ? nav.cookieEnabled : '', // Cookies enabled
		typeof nav.webdriver !== 'undefined' ? nav.webdriver : '', // Automation detection
		// AUDIO/VIDEO CAPABILITY (hardware-tied) ---
		typeof AudioContext !== 'undefined' ? new AudioContext().destination.maxChannelCount : '', // Audio channels
	].join('|');
	return hashGenerate(data);
}

// PASSWORD-DERIVED KEY (PDK) -----------------------------------------------------------------
// PBKDF2 with 100k iterations for slow brute-force resistance
const PDK_ITERATIONS = 100000;
const PDK_KEY_LENGTH = 256;

export async function deriveKeyFromPassword(password, salt) {
	const encoder = new TextEncoder();
	// SECURE CONTEXT (HTTPS/localhost) - use Web Crypto API ---------------------------
	if (crypto?.subtle) {
		const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
		const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: PDK_ITERATIONS, hash: 'SHA-256' }, keyMaterial, PDK_KEY_LENGTH);
		return btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
	}
	// HTTP FALLBACK (testing only) - simple iterative hash ---------------------------
	console.warn('Using insecure key derivation (HTTP context) - for testing only!');
	let derived = password + salt;
	for (let i = 0; i < 1000; i++) derived = hashGenerate(derived + salt + i);
	return btoa(derived.slice(0, 32));
}

// PDK SESSION STORAGE -----------------------------------------------------------
// Steps: keep PDK only in sessionStorage so it dies with the tab/session; forage worker can still encrypt it before persisting.
export function storePDK(pdk) {
	sessionStorage.setItem('_pdk', pdk);
}

export function getPDK() {
	return sessionStorage.getItem('_pdk');
}

export function clearPDK() {
	sessionStorage.removeItem('_pdk');
}

export async function clearPDKFromWorker() {
	// Clear encrypted PDK from IndexedDB via worker
	return forage({ mode: 'clearPDK' });
}

export async function clearDEKFromWorker() {
	// Clear encrypted DEK and prune all device-bound data via worker (GDPR remote wipe)
	return forage({ mode: 'clearDEK' });
}

// GENERATE HASH FUNCTION --------------------------------------------------------------------
function hashGenerate(ascii) {
	function rRot(v, a) {
		return (v >>> a) | (v << (32 - a));
	}

	const maxWord = 2 ** 32,
		result = [],
		words = [],
		asciiBitLength = ascii.length * 8;
	let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const k = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1,
		0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	ascii += '\x80';
	while ((ascii.length % 64) - 56) ascii += '\x00';
	for (let i = 0; i < ascii.length; i++) words[i >> 2] |= ascii.charCodeAt(i) << (((3 - i) % 4) * 8);
	((words[words.length] = (asciiBitLength / maxWord) | 0), (words[words.length] = asciiBitLength));
	for (let j = 0; j < words.length; ) {
		const w = words.slice(j, (j += 16)),
			oldHash = hash.slice(0);
		for (let i = 0; i < 64; i++) {
			const [w15, w2, a, e] = [w[i - 15], w[i - 2], hash[0], hash[4]];
			const temp1 = hash[7] + (rRot(e, 6) ^ rRot(e, 11) ^ rRot(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] + (w[i] = i < 16 ? w[i] : (w[i - 16] + (rRot(w15, 7) ^ rRot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rRot(w2, 17) ^ rRot(w2, 19) ^ (w2 >>> 10))) | 0);
			const temp2 = (rRot(a, 2) ^ rRot(a, 13) ^ rRot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
			hash = [(temp1 + temp2) | 0].concat(hash);
			hash[4] = (hash[4] + temp1) | 0;
		}
		for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
	}
	for (let i = 0; i < 8; i++) for (let j = 3; j + 1; j--) result.push(((hash[i] >> (j * 8)) & 255).toString(16).padStart(2, '0'));
	return result.join('');
}

export function splitStrgOrJoinArr(obj, method = 'split') {
	const applyMethod = (key, delimiter, isNum?) => {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			if (method === 'split' && typeof obj[key] === 'string') obj[key] = obj[key]?.split(delimiter).map(item => (isNum ? Number(item) : item)) || [];
			else if (method === 'join' && Array.isArray(obj[key]) && !obj[key].some(item => typeof item === 'object')) obj[key] = obj[key].join(delimiter);
		}
	};
	['basics', 'indis', 'traits', 'cities'].forEach(key => applyMethod(key, ',', key === 'traits' ? false : true));
	['favs', 'exps'].forEach(key => applyMethod(key, '|'));

	return obj;
}

// FETCH OWN PROFILE --------------------------------------------------------------------------
export async function fetchOwnProfile(brain) {
	const { data: profile } = await axios.post('user', { mode: 'profile' });
	(Object.assign(brain.user, splitStrgOrJoinArr(profile)), forage({ mode: 'set', what: 'user', val: brain.user }));
}

let forageInited = false;
// PERSISTENT WORKERS - receive auth/DEK broadcasts, stay alive for session ---------------------------
const encryptedModes = new Set(['user', 'chat', 'comms', 'past', 'alerts']); // PDK-encrypted (user-bound)
const deviceBoundModes = new Set(['events', 'users', 'miscel']); // Device-scoped persistent workers (events/users DEK-encrypted, miscel unencrypted)
const allPersistentModes = new Set([...encryptedModes, ...deviceBoundModes]);
const workerAliases = { eve: 'events', use: 'users' }; // Alternate names map to primary workers
const encryptionWorkers = [...allPersistentModes].reduce((acc, what) => {
	acc[what] = new Worker(new URL('./workers/forageSetWorker.js', import.meta.url), { type: 'module' });
	return acc;
}, {});

// EXECUTE WORKER - uses request IDs to handle parallel requests to same worker ---------------------------
let reqCounter = 0;
const WORKER_TIMEOUT = 30000; // 30s timeout for worker operations

function executeWorker(worker, { mode, what, id, val }) {
	return new Promise((resolve, reject) => {
		const isPersistent = allPersistentModes.has(what) || workerAliases[what] || what === 'auth',
			reqId = ++reqCounter;

		const timer = setTimeout(() => (cleanup(), reject(new Error(`Worker timeout: ${mode}:${what}`))), WORKER_TIMEOUT);
		const handleMessage = ({ data }) => {
			if (data.reqId === reqId) (cleanup(), data.error ? reject(new Error(data.error)) : resolve(data.data));
		};
		const handleError = error => (cleanup(), reject(error));

		const cleanup = () => {
			(clearTimeout(timer), worker.removeEventListener('message', handleMessage), worker.removeEventListener('error', handleError));
			if (!isPersistent) worker.terminate();
		};

		(worker.addEventListener('message', handleMessage), worker.addEventListener('error', handleError), worker.postMessage({ mode, what, id, val, reqId }));
	});
}

// LOCAL FORAGE ROUTER ---------------------------------------------------------------------------
export async function forage({ mode, what, id, val }: { mode: string; what?: string; id?: string | string[]; val?: any }): Promise<any> {
	try {
		const params = { mode, what, id, val },
			createWorker = () => new Worker(new URL('./workers/forageSetWorker.js', import.meta.url), { type: 'module' });

		const initWorker = async worker => {
			return new Promise((resolve, reject) => {
				const handleInit = ({ data }) => (data.inited ? (cleanup(), resolve(worker)) : data.error && (cleanup(), reject(new Error(data.error))));
				const handleError = err => (cleanup(), reject(err));
				const cleanup = () => (worker.removeEventListener('message', handleInit), worker.removeEventListener('error', handleError));
				(worker.addEventListener('message', handleInit), worker.addEventListener('error', handleError), worker.postMessage({ mode: 'init' }));
			});
		};

		if (mode === 'del' && what === 'everything') {
			const tmp = createWorker();
			(await initWorker(tmp), await executeWorker(tmp, params));
			Object.keys(encryptionWorkers).forEach(key => (encryptionWorkers[key].terminate(), (encryptionWorkers[key] = createWorker())));
			return ((forageInited = false), true);
		}

		if (mode === 'clearPDK' || mode === 'clearDEK') return forageInited && (await Promise.all(Object.values(encryptionWorkers).map(worker => executeWorker(worker, params))));

		if (what === 'auth') {
			if (!forageInited) await Promise.all(Object.values(encryptionWorkers).map(worker => initWorker(worker))).then(() => (forageInited = true));
			const workers = Object.values(encryptionWorkers),
				primary = workers[0];
			return await Promise.all(
				workers.map(w => {
					const p = { ...params };
					if (w !== primary && p.val?.prevAuth) ((p.val = { ...params.val }), delete p.val.prevAuth);
					return executeWorker(w, p);
				})
			);
		}

		if (allPersistentModes.has(what) || workerAliases[what]) {
			const key = workerAliases[what] || what;
			if (!forageInited) await Promise.all(Object.values(encryptionWorkers).map(worker => initWorker(worker))).then(() => (forageInited = true));
			try {
				return await executeWorker(encryptionWorkers[key], params);
			} catch (e) {
				(console.warn(`Restarting worker ${key}:`, e.message), encryptionWorkers[key].terminate(), (encryptionWorkers[key] = createWorker()));
				return (await initWorker(encryptionWorkers[key]), executeWorker(encryptionWorkers[key], params));
			}
		}

		const ephemeral = createWorker();
		return (await initWorker(ephemeral), executeWorker(ephemeral, params));
	} catch (error) {
		console.error('FORAGE ERROR', error);
		throw error;
	}
}

// TRIM SNAP OBJECT ---------------------------------------------------------------------------
export function trim(snap) {
	return Object.fromEntries(Object.entries(snap).filter(([key]) => !['id', 'init', 'last', 'sherChanged', 'changed', 'sherData', 'fetch'].includes(key)));
}

// DELETE FALSY VALUES ------------------------------------------------------------------
export function delUndef(obj: any, empStr = false, zeros = false, falses = false): any {
	const trimmedObj = Object.keys(obj).reduce((acc, key) => {
		const value = obj[key];
		if (value instanceof Date || (value && (Array.isArray(value) ? value.length : typeof value === 'object' ? Object.keys(value).length : value)) || (empStr && value === '') || (falses && value === false) || (zeros && value === 0)) acc[key] = value;
		return acc;
	}, {});
	if (Object.keys(trimmedObj).length) return trimmedObj;
}

// GET CONTENT OR SHERLOCK  -AVAIL -------------------------------------------------------------
export function getFilteredContent({ what, brain, snap = {}, event = {}, show = {}, avail, sherData, isForMap }: any) {
	let [curCitiesSet, arrs] = [new Set(snap.cities || brain.user.curCities), ['indis', 'basics', 'traits']];
	let [items, sherAvail] = [[], { genders: [], minAge: 0, maxAge: 0, ...arrs.reduce((acc, key) => ({ ...acc, [key]: new Set() }), {}) }];
	const { time = 'anytime', types = [], contView = 'events', sort } = snap || {};

	const sortItems = (a, b) => {
		if (contView === 'events') {
			const sortFns = {
				popular: () => b.rank - a.rank || new Date(a.starts).getTime() - new Date(b.starts).getTime(),
				earliest: () => a.starts - b.starts,
				nearest: () => {
					const aDistance = Number.isFinite(a.distance) ? a.distance : Infinity;
					const bDistance = Number.isFinite(b.distance) ? b.distance : Infinity;
					return aDistance - bDistance;
				},
				intimate: () => 3 * a.surely + a.maybe - (3 * b.surely + b.maybe),
				busy: () => 3 * b.surely + b.maybe - (3 * a.surely + a.maybe),
			};
			return (sortFns[sort] || (() => 0))();
		} else {
			const sortFns = {
				popular: () => {
					const [ai, bi] = [a.sortProps?.interScore || 0, b.sortProps?.interScore || 0];
					const [as, bs] = [a.score || 0, b.score || 0];
					const weight = 15; // prefer sure attendances, but allow high-score users to outrank
					const ac = ai * weight + as;
					const bc = bi * weight + bs;
					if (bc !== ac) return bc - ac;
					if (bi !== ai) return bi - ai;
					return bs - as;
				},
				earliest: () => {
					const aStart = Number.isFinite(a.sortProps?.starts) ? a.sortProps.starts : Infinity;
					const bStart = Number.isFinite(b.sortProps?.starts) ? b.sortProps.starts : Infinity;
					if (aStart !== bStart) return aStart - bStart;
					// tie-breakers: higher interScore then score
					const interDiff = (b.sortProps?.interScore || 0) - (a.sortProps?.interScore || 0);
					if (interDiff !== 0) return interDiff;
					return (b.score || 0) - (a.score || 0);
				},
				nearest: () => (Number.isFinite(a.distance) && Number.isFinite(b.distance) ? a.distance - b.distance : (a.sortProps?.distance ?? Infinity) - (b.sortProps?.distance ?? Infinity)),
				intimate: () => (a.sortProps?.intimate ?? Infinity) - (b.sortProps?.intimate ?? Infinity),
				busy: () => (b.sortProps?.busy ?? -Infinity) - (a.sortProps?.busy ?? -Infinity),
			};
			return (sortFns[sort] || (() => 0))();
		}
	};

	try {
		if (what === 'topEvents') {
			const bestOfIDs = new Set(brain.bestOfIDs as any);
			items = [...bestOfIDs].map((id: any) => (brain.events as any)[id]).filter(Boolean);
		} else if (event.id) {
			if (brain.user.eveUserIDs?.[event.id]) items = brain.user.eveUserIDs[event.id].map((id: any) => (brain.users as any)[id]);
			else ((items = Object.values(brain.users as any).filter((user: any) => user.eveInters?.some(([eveID]: any[]) => eveID === event.id))), (brain.user.eveUserIDs[event.id] = items.map((user: any) => user.id)));
		} else {
			const { start, end } = time !== 'anytime' ? getTimeFrames(time) : {};
			const selTypesSet = new Set(types.filter(type => !avail || avail.types.includes(type)));
			const itemsOnMapSet = !isForMap && show.map === true && brain.itemsOnMap ? new Set(brain.itemsOnMap as any) : null;
			const allowedStates = new Set(['meta', 'basi', 'basiDeta']);

			// FIND RELEVANT EVENTS ------------------------------------------------------------------
			items = itemsOnMapSet && !isForMap ? [...itemsOnMapSet].map((id: any) => (brain.events as any)[id]).filter(Boolean) : Object.values(brain.events as any).filter(({ cityID, type, starts, id, lat, state }: any) => curCitiesSet.has(cityID) && selTypesSet.has(type) && allowedStates.has(state) && (time === 'anytime' || (starts >= start && starts < end)) && (!isForMap ? !itemsOnMapSet || itemsOnMapSet.has(id) : lat));

			if ((show.sherlock && what === 'sherAvail') || (!isForMap && what === 'content' && contView === 'users')) {
				const relevantEventIds = new Set(items.filter(e => e?.type.startsWith('a')).map(e => e.id));
				const gendersSet = new Set();
				items = [brain.user, ...Object.values(brain.users as any)].filter((user: any) => {
					const relevantInters = user.eveInters?.filter(([id]: any[]) => relevantEventIds.has(id)) || [];
					if (!relevantInters.length) return false;
					gendersSet.add(user.gender);
					user.sortProps = relevantInters.reduce(
						(acc: any, [id, inter]: any[]) => {
							const ev = (brain.events as any)[id];
							const sureScore = 3 * (ev?.surely || 0) + (ev?.maybe || 0);
							if (inter === 'sur') user.id === brain.user.id ? (acc.interScore += 100) : acc.interScore++;
							acc.starts = Math.min(acc.starts, Number.isFinite(ev?.starts) ? ev.starts : Infinity);
							acc.distance = Math.min(acc.distance, Number.isFinite(ev?.distance) ? ev.distance : Infinity);
							acc.intimate = Math.min(acc.intimate, sureScore);
							acc.busy = Math.max(acc.busy, sureScore);
							return acc;
						},
						{ interScore: 0, starts: Infinity, distance: Infinity, intimate: Infinity, busy: -Infinity }
					);
					return true;
				});

				if (show.sherlock && sherData) {
					const { mode = 'standard', gender, minAge, maxAge } = sherData;
					const sherFilters = arrs.reduce((acc, key) => {
						acc[key] = Array.isArray(sherData[key]) ? sherData[key] : [];
						return acc;
					}, {});
					sherAvail.genders = [...gendersSet].filter(Boolean);
					const minAgeNum = Number(minAge);
					const maxAgeNum = Number(maxAge);
					const hasMinAge = Number.isFinite(minAgeNum) && minAgeNum > 0;
					const hasMaxAge = Number.isFinite(maxAgeNum) && maxAgeNum > 0;
					items = items.filter(u => {
						const userAgeRaw = Number(u.age);
						const userAge = Number.isFinite(userAgeRaw) ? userAgeRaw : null;
						const minAgeOk = !hasMinAge || (userAge !== null && userAge >= minAgeNum);
						const maxAgeOk = !hasMaxAge || (userAge !== null && userAge <= maxAgeNum);
						const modeChecks = {
							loose: arrs.some(a => !sherFilters[a].length || sherFilters[a].some(i => u[a]?.includes(i))),
							standard: arrs.every(a => !sherFilters[a].length || sherFilters[a].some(i => u[a]?.includes(i))),
							strict: arrs.every(a => sherFilters[a].every(i => u[a]?.includes(i))),
						};
						const passesMode = modeChecks[mode] ?? modeChecks.standard;
						if ((!gender || u.gender === gender) && minAgeOk && maxAgeOk && passesMode) {
							if (userAge !== null) {
								sherAvail.minAge = Math.min(sherAvail.minAge, userAge);
								sherAvail.maxAge = Math.max(sherAvail.maxAge, userAge);
							}
							arrs.forEach(a => Array.isArray(u[a]) && u[a].forEach(i => sherAvail[a].add(i)));
							return true;
						}
						return false;
					});
				}
			}
		}

		if (what === 'sherAvail') {
			arrs.forEach(a => (sherAvail[a] = Array.from(sherAvail[a] as any)));
			sherAvail.minAge = Number.isFinite(sherAvail.minAge) ? sherAvail.minAge : null;
			sherAvail.maxAge = Number.isFinite(sherAvail.maxAge) && sherAvail.maxAge !== -Infinity ? sherAvail.maxAge : null;
			return sherAvail;
		}

		if (!isForMap) {
			items = items.filter(Boolean).sort(sortItems);
			if (['sur', 'may'].includes(event.inter)) items.unshift(brain.user);
		}

		return items;
	} catch (error) {
		console.error('GET ERROR', error);
		throw error;
	}
}

// GET AWARDS ---------------------------------------------------------------------------
export const getAwards = sum => {
	const res = [];
	for (const p of [32, 16, 8, 4, 2, 1]) if (sum >= p) (res.push(p), (sum -= p));
	return res.sort();
};

let eventBadges = {};
const badgeArrs = ['indis', 'basics', 'traits'];
//todo do different percentage for traits for badges, or maybe even counts
// TODO move the logic for new content into process metas function, keep this only for a single item
// TODO probably convert all interactions to objects for immediate lookupupdateInteractions

// INFO integrate extractInteractions into SET PROPS TO CONTENT

export function extractInteractions(items, mode, brain, _unused = undefined) {
	try {
		if (!items) return;
		const unstableObj = brain.user.unstableObj;
		if (!unstableObj) return;
		unstableObj.gotSQL ??= { events: [], users: [] };
		const gotSQLset = new Set(Array.isArray(unstableObj.gotSQL[mode]) ? unstableObj.gotSQL[mode] : []);
		const interactions = { eveInters: { sur: [], may: [], int: [] }, linkUsers: [], rateEve: [], rateUsers: [], rateComm: [] };
		const ratingKey = mode === 'events' ? 'rateEve' : mode === 'users' ? 'rateUsers' : 'rateComm';
		const iterable = Array.isArray(items) ? items : typeof items === 'object' && items !== null ? Object.values(items) : [];

		for (const rawItem of iterable) {
			if (!rawItem) continue;
			let id;
			let item = rawItem;
			if (Array.isArray(rawItem)) {
				[id, ...item] = rawItem;
				if (item[0] && typeof item[0] === 'object' && !Array.isArray(item[0])) item = { ...item[0], id };
				else {
					const [first, second, third] = item;
					item = { id, mark: first, awards: second, interPriv: third };
				}
			} else if (typeof rawItem === 'object' && rawItem !== null) {
				({ id } = rawItem);
			}
			if (id == null) id = item?.id;
			if (id == null) continue;
			const { inter, interPriv, mark, awards } = item || {};
			if (mark !== undefined && mark !== null) interactions[ratingKey].push([id, mark, awards]);
			if (awards && !Array.isArray(awards)) item.awards = getAwards(awards);
			if (inter) {
				if (interactions.eveInters[inter]) interactions.eveInters[inter].push([id, inter, interPriv]);
				else if (inter === 'del')
					(delete item.inter,
						Object.values(unstableObj.eveInters as any).forEach((interactionsArray: any[]) =>
							interactionsArray.splice(
								interactionsArray.findIndex((interactionRow: any[]) => interactionRow[0] === id),
								1
							)
						));
			}
			gotSQLset.add(id);
		}

		unstableObj.gotSQL[mode] = Array.from(gotSQLset);
		updateInteractions({ brain, add: interactions });
		return interactions;
	} catch (err) {
		console.error('EXTRACT INTERACTIONS ERROR', err);
		return null;
	}
}

// TODO meetstats setting should be here??? really??? why its not in meta processsing??? just a quick thought, verify.
// SET PROPS TO CONTENT ------------------------------------------------------------------
export function setPropsToContent(mode, items, brain, isNewCont = false) {
	try {
		const { eveInters = [], rateEve, rateUsers, linkUsers = [], rateComm } = brain.user.unstableObj || brain.user;
		const ratingIDsSrc = (mode === 'events' ? rateEve : mode === 'users' ? rateUsers : rateComm) || [];

		const ratingMap = new Map(ratingIDsSrc.map(([id, mark, awards]) => [id, [mark, awards]]));
		const linksMap = mode === 'users' ? new Map(linkUsers.map(([id, trusts]) => [id, [id, trusts]])) : null;
		// Ensure eveInters is iterable array
		const eveIntersArr = Array.isArray(eveInters) ? eveInters : [];
		const intersMap = mode === 'events' ? new Map(eveIntersArr.map(([eveID, inter, priv]) => [eveID, [inter, priv]])) : null;

		for (const item of (Array.isArray(items) ? items : Object.values((items || {}) as any)) as any[]) {
			const [{ id, surely, owner, user, flag, state }, [mark, awards]] = [item, (ratingMap.get((item as any).id) as any) || []];
			let inter, priv, badges, linkedId, trusts;

			if (mode === 'users') {
				[linkedId, trusts] = ((linksMap?.get(id) as any[]) || []) as any[];
				if (isNewCont) {
					for (const [eveID, inter] of (item.eveInters || []) as any[]) {
						if (inter === 'sur') {
							eventBadges[eveID] ??= { indis: {}, basics: {}, traits: {} };
							for (const arr of badgeArrs) for (const i of item[arr]) eventBadges[eveID][arr][i] = (eventBadges[eveID][arr][i] || 0) + 1;
						}
					}
				}
			} else if (mode === 'events') {
				[inter, priv] = intersMap.get(id) || [];
				if (isNewCont)
					((badges = eventBadges[id]),
						badges &&
							surely > 1 &&
							(badges = Object.fromEntries(
								Object.entries(badges).map(([key, obj]) => [
									key,
									Object.keys(obj)
										.filter(k => obj[k] > 1 && obj[k] >= surely * 0.3)
										.sort((a, b) => obj[b] - obj[a]),
								])
							)),
						badges && !Object.values(badges as any).some((badgeArray: any) => badgeArray?.length) && (badges = null),
						true);
			}

			// compute user distance using nearest attending event's distance
			if (mode === 'users' && Array.isArray(brain.user.location) && brain.user.location.length === 2 && !Number.isFinite(item.distance)) {
				const distances = (item.eveInters || []).map(([eveID]) => brain.events[eveID]?.distance).filter(d => typeof d === 'number' && d >= 0);
				if (distances.length) item.distance = Math.min(...distances);
			}

			Object.assign(item, {
				...(mode === 'events' && {
					...(state === 'del' && { deleted: true }),
					...(flag === 'can' && { canceled: true }),
					...(badges && { badges }),
					...(inter && { inter, interPriv: priv }),
					...(brain.user.invitesIn[id] || brain.user.invitesOut[id] ? { invites: { in: brain.user.invitesIn[id] || [], out: brain.user.invitesOut[id] || [] } } : {}),
					...(brain.user.invitesIn[id]?.some(u => u.flag === 'ok') && !brain.user.invitesIn[id]?.some(u => u.flag === 'acc') && { invited: true }),
					own: owner == brain.user.id,
				}),
				...(mode === 'users' && linkedId && { linked: true, trusts: Boolean(trusts) }),
				...(['comments', 'messages'].includes(mode) && { own: user == brain.user.id }),
				...{
					mark: Number(mark || 0),
					awards: getAwards(awards || item.awards || 0),
				},
			});
		}

		eventBadges = {};
		return items;
	} catch (err) {
		console.error('SET PROPS ERROR', { mode, itemCount: items?.length || 0, error: err });
		eventBadges = {}; // Reset on error to prevent stale data
		throw err;
	}
}

// HUMANIZE DATES AND TIMES ---------------------------------------------------------------------------
/**About this function:
 * 
The function takes in date in miliseconds and returns a string in a human-friendly format and natural language.
Parameters:
1. dateInMs: Date in miliseconds
2. prevDateInMs: date of a previous item in the rendered list (fE:chat messages). returns only time if both on same day.
3. getLabel: return only a shortDesc event time label (e.g. 'today', 'yesterday', 'tomorrow', 'last week', 'in a week', 'last month', 'old')
4. hideFarTime: hides time if the date is far in the future
5. getGranularPast: returns a granular time difference for recent past in minutes. (1.min, 3.min etc.)
6. thumbRow: used for event thumbnails on users cards (accepts 'upper' or 'bottom' for different rows)
7. endsInMs: if getLabet is TRUE it will change the label to 'Dnes proběhlo' if the event has already ended today. 
*/
export function humanizeDateTime(inp) {
	const { dateInMs, prevDateInMs, getLabel, hideFarTime, getGranularPast, thumbRow, endsInMs, timeOnly } = inp;
	if (!dateInMs) return;

	try {
		const date = new Date(dateInMs);
		const currentDate = new Date();
		const prevDate = prevDateInMs ? new Date(prevDateInMs) : null;
		const time = date.toTimeString().substring(0, 5).replace(/^0+/, '').replace(/^:/, '0:');
		const sameDayAsPrev = prevDate && date.toDateString() === prevDate.toDateString();
		const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
		const currentDateOnly = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
		const daysDiff = Math.round((dateOnly.getTime() - currentDateOnly.getTime()) / (1000 * 3600 * 24));
		if (timeOnly) return time;

		const isToday = daysDiff === 0;
		const secsDiff = Math.floor((date.getTime() - currentDate.getTime()) / 1000);
		const minsDiff = Math.floor(secsDiff / 60);
		const hoursDiff = Math.floor(minsDiff / 60);

		if (sameDayAsPrev && isToday) return Math.abs(minsDiff) >= 60 ? `v ${time}` : '';
		const alreadyPassed = dateInMs < Date.now() && (endsInMs ? endsInMs < Date.now() : true);
		const labels = {
			0: alreadyPassed ? 'Dnes proběhlo' : 'Dnešní',
			'-1': 'včerejší',
			1: 'zítra',
			'-7': 'minulý týden',
			7: 'v týdnu',
			'-30': 'minulý měsíc',
			'-31': 'stará',
		};
		let label = labels[daysDiff] || (daysDiff > -7 && daysDiff < 0 ? 'minulý týden' : daysDiff > 0 && daysDiff < 7 ? 'v týdnu' : daysDiff > -30 && daysDiff <= -7 ? 'minulý měsíc' : daysDiff <= -30 ? 'stará' : '');

		if (getLabel) return label;
		if (getGranularPast) {
			if (Math.abs(secsDiff) < 15) return 'Právě teď';
			if (Math.abs(minsDiff) < 60) return `${Math.abs(minsDiff)} min.`;
			if (Math.abs(hoursDiff) < 24) return `${Math.abs(hoursDiff)} hod.`;
			if (Math.abs(daysDiff) < 7) return `${Math.abs(daysDiff)} dny`;
			if (Math.abs(daysDiff) < 30) return `${Math.floor(Math.abs(daysDiff) / 7)} týdny`;
			if (Math.abs(daysDiff) < 365) return `${Math.floor(Math.abs(daysDiff) / 30)} měsíce`;
			return `${Math.floor(Math.abs(daysDiff) / 365)} roky`;
		}

		const weekDays = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
		const [day, month, year] = [date.getDate(), date.getMonth() + 1, date.getFullYear()];
		const showWeekDay = daysDiff <= 60 && daysDiff >= 3;

		let datePart = isToday ? 'Dnes' : daysDiff === 1 ? 'Zítra' : daysDiff === 2 ? 'Pozítří' : daysDiff === -1 ? 'Včera' : showWeekDay ? `${weekDays[date.getDay()].slice(0, daysDiff <= 6 ? undefined : 2)} ${daysDiff <= 6 ? '' : `${day}.${month}${year === currentDate.getFullYear() ? '' : `.${year}`}`}` : `${day}.${month}${year === currentDate.getFullYear() ? '' : `.${year}`}`;

		const dateString = `${datePart}${hideFarTime && daysDiff > 90 ? '' : ` v ${time}`}`;
		if (thumbRow === 'upper') return daysDiff <= 7 ? weekDays[date.getDay()].slice(0, 2) : year === currentDate.getFullYear() ? (showWeekDay ? datePart.split(' ')[1] : datePart) : `${day}.${month}`;
		if (thumbRow === 'bottom') return daysDiff <= 7 ? time : year === currentDate.getFullYear() ? `${daysDiff <= 60 ? `${weekDays[date.getDay()].slice(0, 2)} ${time}` : weekDays[date.getDay()]}` : year.toString();

		return dateString;
	} catch (err) {
		throw new Error(err);
	}
}

// INFLECT NAME (CZECH INSTRUMENTAL CASE) ----------------------------------------------------
/**About this function:
- It takes in a name and inflects it to the instrumental case (7. pád) in Czech language.
- The function is used to create a natural sounding sentences containing names (e.g., "s Petrem").
*/
export function inflectName(name) {
	const ends = {
		a: 'ou',
		e: 'em',
		i: 'ím',
		o: 'em',
		u: 'em',
		y: 'ým',
		á: 'ou',
		é: 'ým',
		í: 'ím',
		ě: 'em',
		ů: 'em',
		ř: 'řem',
		š: 'šem',
		ž: 'žem',
		c: 'cem',
		k: 'kem',
		g: 'gem',
		h: 'hem',
		ch: 'chem',
		j: 'jem',
		l: 'lem',
		m: 'mem',
		n: 'nem',
		p: 'pem',
		r: 'rem',
		s: 'sem',
		t: 'tem',
		v: 'vem',
		z: 'zem',
	};
	const [l1, l2] = [name.slice(-1), name.slice(-2)];
	return ends[l2] ? name.slice(0, -2) + ends[l2] : ends[l1] ? name.slice(0, -1) + ends[l1] : name + 'em';
}

// ARE EQUAL ---------------------------------------------------------------------------
/**About this function:
- It compares two objects or arrays and returns true if they are equal.
- The function is used to prevent unnecessary re-renders in React components.
*/
export function areEqual(a, b) {
	if (a === b) return true;
	if (a == null || b == null || typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => areEqual(v, b[i]));
	if (typeof a === 'object') {
		const [ka, kb] = [Object.keys(a), Object.keys(b)];
		return ka.length === kb.length && ka.every(k => areEqual(a[k], b[k]));
	}
	return false;
}

// DEBOUNCER ---------------------------------------------------------------------------
/**About this function:
- It takes in a function and a delay time and returns a debounced version of the function.
- The immediate parameter is used to execute the function immediately on the first call.
*/
export function debounce(func, wait, immediate = false) {
	let timeout;
	return function (...args) {
		const context = this;
		const later = () => {
			timeout = null;
			if (!immediate) func.apply(context, args);
		};
		const callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) func.apply(context, args);
	};
}
