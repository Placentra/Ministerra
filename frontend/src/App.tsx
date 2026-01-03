// todo might want to create a worker for this and to process and cleanup brain in general when starting app
// todo possibly fetch metas when fastLoaded and user opens galleryIDs, instead of fetching metas/basics individualy

// todo the interaction interval needs to store only if there was a mouse interaction (for each mouseclick, set timestamp in brain, and then check if there was a mouseclick in the last 30 seconds)
// TODO show visual indicator, that data is being saved, so that users dont close the window prematurely.
// TODO might need to move the pastEve deletion to galleryIDs, otherwise the entire pastEve would have to be decrypted on init.
// TODO need to create interval to get rid of very old past events + track when they were last opened
// TOdo replace const path  in foundation loaderr with the url parsing from navigate and loader params
// TODO need to implement auth rotation somehow. either full, or procedural using backwards calculation
// TODO store events under city IDs in local storage, find out efficient way to progressively delete events from cities which user is not interested in
// TODO convert all arrays to objects {id: value}
// TODO implement limiting of number of stored items in local storage = by number as well as timestamps (?)
// todo implement some kind of one time alert for when theere is too much data in local storage. create a flag to only ping our server once
// TODO only replace problematic parts of brain, not the whole brain
// TODO need to check if we remove localy cached data eveewhere when server does not return them if requested. might need to implement some sort of counter and store it in some kind of map. remove it from local if count reaches 3 unsucessfull requests.
// TODO implement auth rotation, currently not possible, since it breaks down decrypting of previously stored stuff
// TODO could probably ask user for password everytime  he comes back and generate the btoa or some other key from that. (in case of password  change, need to re-encrypt everything)
// TODO when deleting tempfiles from  galleryIDs for example, maybe base it on the items sync, not a ttl timestamp, because that always deletes everything, even if some items are not stale yet.

// BUG design2 in eveCards is broken when viewing microprofile of attendees
// INFO setup seerver to send some bullshit responses on all gets/posts and see what happens.
// BUG implement a last resort local reset, which would be baseed on a time based counters of app init into an error page (so the app doesn´t load at all) and if there are 3 fatal failiure in less than 24 hours and at least 8 hours apart (it would clear sensitive data from indexed db/workers) and the app would simply start from scratch. if that doesn´t help, we could flush completely everything from the frontend. it would be complex, but worth it.

// APPLICATION ENTRY POINT ---
// Initializes the React application, configures Axios, and manages dynamic viewport scaling.
import ReactDOM from 'react-dom/client';
import Router from './Router';
import { useRef, useState, useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import ErrorBoundary from './comp/ErrorBoundary';
import { ErrorProvider } from './contexts/ErrorContext';
import { notifyGlobalError } from './hooks/useErrorsMan';
import axios from 'axios';
import './css/SpacingElements.css';
import './css/FluiDesign.css';
import './css/fontSizes.css';
import './css/padBot.css';
import './css/padTop.css';
import './css/padVer.css';
import './css/padHor.css';
import './css/marBot.css';
import './css/marTop.css';
import './css/marVer.css';
import './css/marHor.css';
import './css/aspectRatio.css';
import './css/VisualClasses.css';
import { forage, getDeviceFingerprint } from '../helpers';
import { emptyBrain } from '../sources';
import { decode } from 'cbor-x';
import { logoutCleanUp } from '../helpers';
import { foundationLoader } from './loaders/foundationLoader';
import { getToken } from './utils/getToken';
import { normalizeIncomingDateFieldsToMs, normalizeOutgoingDateFieldsToMs } from './utils/dateNormalization';

// GLOBAL STATE AND CONFIG ---
let brain;
window.__wipeInProgress ||= false;
const backendUrl = import.meta.env.VITE_BACK_END?.replace('127.0.0.1', 'localhost');
(axios.defaults.baseURL = backendUrl),
	(axios.defaults.withCredentials = true),
	(axios.defaults.timeout = 8000),
	(axios.defaults.headers.common['Accept'] = 'application/cbor, application/json'),
	(axios.defaults.responseType = 'arraybuffer');
const throttleMap = (window.__throttleMap ||= new Map());

// VIEWPORT SCALING LOGIC ---
// Calculates and sets the base font size for fluid typography based on viewport width.
function activateDynamicScaling() {
	const BASE_FONT_SIZE = 62.5,
		REF_WIDTH = 1920,
		MIN_WIDTH = 320,
		MIN_SCALE = 0.55,
		PHONE_ADJUST = 0;
	const updateFontSize = () => {
		const vw = Math.max(window.innerWidth || MIN_WIDTH, MIN_WIDTH),
			widthRatio = Math.min(vw / REF_WIDTH, 1),
			baseScale = MIN_SCALE + widthRatio * (1 - MIN_SCALE);
		const progressiveAdjust = vw < 768 ? (1 - widthRatio) * PHONE_ADJUST : 0,
			scale = Math.max(MIN_SCALE, baseScale + progressiveAdjust);
		document.documentElement.style.fontSize = `${(BASE_FONT_SIZE * scale).toFixed(3)}%`;
	};
	if (window.__dynamicScalingHandler) window.removeEventListener('resize', window.__dynamicScalingHandler), window.removeEventListener('orientationchange', window.__dynamicScalingHandler);
	(window.__dynamicScalingHandler = updateFontSize),
		updateFontSize(),
		window.addEventListener('resize', window.__dynamicScalingHandler, { passive: true }),
		window.addEventListener('orientationchange', window.__dynamicScalingHandler, { passive: true });
}

// DATA DECODING UTILITY ---
// Handles CBOR, JSON, and plain text response data decoding.
const decodeResponseData = (data, contentType = '') => {
	if (!data) return data;
	try {
		const isBuffer = data instanceof ArrayBuffer || ArrayBuffer.isView(data);

		if (contentType.includes('application/cbor')) {
			data = decode(isBuffer ? new Uint8Array(data as any) : (data as any));
		} else if (contentType.includes('application/json')) {
			const text = isBuffer ? new TextDecoder().decode(data) : data;
			data = JSON.parse(text);
		} else if (isBuffer) {
			data = new TextDecoder().decode(data);
		}

		if (data && typeof data === 'object' && data.contentMetas) {
			for (const cityMetas of data.contentMetas) {
				for (const [id, cborMeta] of Object.entries(cityMetas)) {
					if (id !== 'cityID' && cborMeta) cityMetas[id] = decode(cborMeta as any);
				}
			}
		}
		return data;
	} catch (error) {
		console.warn('Data decoding fallback triggered:', error);
		// Fallback strategies
		try {
			return decode(new Uint8Array(data as any));
		} catch {
			try {
				return JSON.parse(new TextDecoder().decode(data));
			} catch {
				return new TextDecoder().decode(data);
			}
		}
	}
};

// ROOT APP COMPONENT ---
// Core logic for authentication, request interceptors, and application bootstrapping.
function App() {
	const [waitForFoundationLoad, setWaitForFoundationLoad] = useState(window.location.pathname !== '/'),
		brainRef = useRef({ ...emptyBrain }),
		scalingActivated = useRef(false);
	if (!brain) brain = brainRef.current;

	useEffect(() => {
		// DYNAMIC SCALING ACTIVATION ---
		if (!scalingActivated.current) (scalingActivated.current = true), activateDynamicScaling();

		// AXIOS INTERCEPTOR CONFIGURATION ---
		if (!window.__axiosInterceptorsInstalled) {
			const reqId = axios.interceptors.request.use(
				async request => {
					const useAuthToken = Boolean(request.data?.useAuthToken),
						{ token, expired, print } = await getToken(useAuthToken);

					// DATE NORMALIZATION (REQUEST) ----------------------------------------
					// Convert known datetime fields to ms so backend gets a single invariant type.
					if (request?.data && typeof request.data === 'object') request.data = normalizeOutgoingDateFieldsToMs(request.data);
					if (useAuthToken) delete request.data.useAuthToken, (request.data.auth = token);
					else if (token && !window.__wipeInProgress) request.headers['Authorization'] = `Bearer ${token}`;
					if (window.__wipeInProgress)
						try {
							if (request.headers && request.headers['Authorization']) delete request.headers['Authorization'];
							if (request.data && request.data.auth) delete request.data.auth;
						} catch (_) {}
					if (expired) request.data = { ...(request.data || {}), print: print || getDeviceFingerprint() };

					// REQUEST THROTTLING ---
					const urlKey = `${(request.method || 'get').toLowerCase()}:${request.url}`,
						signature = JSON.stringify({ data: request.data ?? null, params: request.params ?? null });
					let sigSet = throttleMap.get(urlKey);
					if (!sigSet) (sigSet = new Set()), throttleMap.set(urlKey, sigSet);
					if (sigSet.has(signature)) return Promise.reject(new Error('Request throttled'));
					sigSet.add(signature),
						(request.__throttle = { urlKey, signature }),
						setTimeout(() => {
							const setForKey = throttleMap.get(urlKey);
							if (setForKey) {
								setForKey.delete(signature);
								if (setForKey.size === 0) throttleMap.delete(urlKey);
							}
						}, 2000);
					(request.__requestStart = Date.now()), window.dispatchEvent(new CustomEvent('requestActivity', { detail: { type: 'start', source: 'axios' } }));
					return request;
				},
				error => Promise.reject(error)
			);

			// THROTTLE CLEARING HELPER ---
			const clearThrottle = config => {
				try {
					const info = config?.__throttle;
					if (!info) return;
					const setForKey = throttleMap.get(info.urlKey);
					if (setForKey) {
						setForKey.delete(info.signature);
						if (setForKey.size === 0) throttleMap.delete(info.urlKey);
					}
					delete config.__throttle;
				} catch (_) {}
			};

			// AXIOS RESPONSE INTERCEPTOR ---
			const resId = axios.interceptors.response.use(
				async response => {
					clearThrottle(response.config), window.dispatchEvent(new CustomEvent('requestActivity', { detail: { type: 'end', source: 'axios' } }));
					if (response.headers?.authorization) {
						const parts = String(response.headers.authorization).split(':'),
							token = parts[0].split(' ')[1],
							expiry = parts[1],
							newReprint = parts[2];
						if (!window.__wipeInProgress)
							(async () => {
								try {
									const existing = await forage({ mode: 'get', what: 'token' }),
										reprintToStore = newReprint || (existing ? existing.split(':')[2] : undefined);
									await forage({ mode: 'set', what: 'token', val: `${token}:${expiry}:${reprintToStore || ''}` });
								} catch (e) {
									console.warn('Token store failed:', e);
								}
							})();
					}
					response.data = decodeResponseData(response.data, response.headers['content-type']);
					// DATE NORMALIZATION ------------------------------------------------
					// Convert known date/datetime fields into ms timestamps.
					response.data = normalizeIncomingDateFieldsToMs(response.data);
					console.log('RESPONSE FROM', response.config?.url, 'TOOK:', Date.now() - (response.config?.__requestStart || 0), 'ms', response.data);
					if (import.meta.env.DEV) console.log('RESPONSE', response.config?.url, 'TOOK:', Date.now() - (response.config?.__requestStart || 0), 'ms');
					return Promise.resolve(response);
				},
				async error => {
					clearThrottle(error.config), window.dispatchEvent(new CustomEvent('requestActivity', { detail: { type: 'end', source: 'axios' } }));
					if (typeof window !== 'undefined' && window.__wipeInProgress) return Promise.reject(error);
					if (error.response?.data) error.response.data = decodeResponseData(error.response.data, error.response?.headers?.['content-type'] || 'application/json');
					if (error.config?.url === '/foundation' && error.response?.data?.code === 'unauthorized') return await logoutCleanUp(brain, emptyBrain, true);
					const errorData = error.response?.data,
						errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
					if (errorCode === 'logout' && !error.config?.__skipLogoutCleanup) return await logoutCleanUp(brain, emptyBrain, true);
					if (!(error?.code === 'ERR_CANCELED' || error?.message === 'canceled') && !error?.config?.__skipGlobalErrorBanner)
						notifyGlobalError(error, typeof errorData === 'object' ? errorData?.message : undefined);
					return Promise.reject(error);
				}
			);
			window.__axiosInterceptorsInstalled = { reqId, resId };
			if (import.meta?.hot)
				import.meta.hot.dispose(() => {
					axios.interceptors.request.eject(reqId), axios.interceptors.response.eject(resId), (window.__axiosInterceptorsInstalled = null);
				});
		}

		// STORAGE QUOTA MONITORING ---
		if (navigator.storage?.estimate)
			navigator.storage
				.estimate()
				.then(estimate => {
					const usedBytes = estimate.usage || 0,
						totalBytes = estimate.quota || 1,
						usedPercentage = (usedBytes / totalBytes) * 100;
					if (import.meta.env.DEV) console.log(`Storage usage: ${usedPercentage.toFixed(2)}%`);
					if (usedPercentage > 90) navigator.storage.persist();
				})
				.catch(error => console.error('Error accessing storage estimate:', error));

		// FOUNDATION DATA LOADING ---
		if (!waitForFoundationLoad) return;
		let mounted = true;
		(async () => {
			try {
				await foundationLoader({ isFastLoad: true, brain });
				if (mounted) (brain.fastLoaded = true), setWaitForFoundationLoad(false);
			} catch (err) {
				console.error('Foundation fast load failed', err);
				if (mounted) setWaitForFoundationLoad(false);
			}
		})();
		return () => {
			mounted = false;
		};
	}, []);

	// MAIN RENDER BRANCH ---
	if (!waitForFoundationLoad) {
		const router = Router({ brain, foundationLoader });
		return (
			<ErrorProvider>
				{/* ERROR BOUNDARY CONTAINER --- */}
				<ErrorBoundary>
					{/* ROUTER PROVIDER MOUNT --- */}
					<RouterProvider router={router} />
				</ErrorBoundary>
			</ErrorProvider>
		);
	}
}

// DOM ROOT MOUNTING ---
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
export default App;
