import { useState, Suspense, lazy, useEffect, useRef } from 'react';
import axios from 'axios';
import { useLocation, useNavigate, Outlet, useLoaderData, useFetcher, ScrollRestoration } from 'react-router-dom';
import { comps, emptyBrain } from '../../sources';
import { logoutCleanUp, debounce } from '../../helpers';
const Home = lazy(() => import('./Home'));
import LogoAndMenu from '../comp/LogoAndMenu';
// MOBILE DETECTION - uses multiple signals for reliability ---------------------------
const setMobile = () => {
	const ua = navigator.userAgent || '';
	const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0; // TOUCH CAPABILITY ---------------------------
	const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(ua); // UA STRING CHECK ---------------------------
	const isSmallViewport = (window.visualViewport?.width || window.innerWidth) < 550; // VIEWPORT WIDTH CHECK ---------------------------
	const isSmallScreen = window.screen.width < 550 && window.devicePixelRatio >= 2; // PHYSICAL SCREEN WITH HIGH DPI ---------------------------
	return isSmallViewport || (hasTouch && (isMobileUA || isSmallScreen));
};
import useFadeIn from '../hooks/useFadeIn';
import { globalContext } from '../contexts/globalContext';
import { disconnectSocketIO } from '../hooks/useSocketIO';
import { notifyGlobalError } from '../hooks/useErrorsMan';

// TODO when loging out, disconnect socket somehow
// TODO create vertical divider with chat
// TODO allow users to be alerted when certain sherlock items are available. display that above the cat filter
// TODO move all man function from small components level up, so that there is only a single one and the small components are leaner
// todo could probably allow for rating of events every year, this would also compensante for the fact, that we might be deleting events which are still active, because of lack of metadata
// TODO insted of  360 use document.element.clientWidth
// TODO create cleanup function to remove sensitive data from events and users after logout or forced logout
// TODO might need to create a VISIBLE spinner when localforage works. so that users dont close the tab and lose data
// INFO REMOVE ESLINT and other packages for production

const LOGOUT_REQUEST_TIMEOUT_MS = 2000;

function Foundation() {
	// STATES / VARIABLES
	const brain = useLoaderData() || {},
		location = useLocation(),
		nowAt = useLocation().pathname.split('/')[1] || 'home',
		loader = useFetcher(),
		navigate = useNavigate(),
		[isMobile, setIsMobile] = useState(setMobile()),
		[menuView, setMenuView] = useState(''),
		[initialize, setInitialize] = useState(brain.user.id ? 'cityEvents' : null),
		[fadedIn, setFadedIn] = useFadeIn({ mode: 'foundation' }),
		restoreScroll = useRef(false);

	useEffect(() => {
		if (loader.state === 'idle' && loader.data) {
			delete loader.data; //keep this
			if (nowAt !== 'home') navigate('/');
			else setInitialize(brain.homeView || 'cityEvents');
		}
		if (!restoreScroll.current && brain.homeView !== 'topEvents') setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 100);
		const [onEscapeKey, onResize] = [e => e.key === 'Escape' && window.history.back(), debounce(() => setIsMobile(setMobile()), 200)];
		restoreScroll.current = nowAt !== 'home';
		window.addEventListener('resize', onResize), document.addEventListener('keydown', onEscapeKey);
		return () => {
			document.removeEventListener('keydown', onEscapeKey);
			window.removeEventListener('resize', onResize);
		};
	}, [loader.state, nowAt, initialize]);

	// LOG OUT SWITCH --------------------------------------------------
	const logOut = async () => {
		const searchParam = ['userDeleted', 'userFrozen'].find(param => brain[param]);
		if (typeof window !== 'undefined') window.__wipeInProgress = true;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), LOGOUT_REQUEST_TIMEOUT_MS);
		try {
			await axios.post('/entrance', { mode: 'logoutDevice' }, { signal: controller.signal, timeout: LOGOUT_REQUEST_TIMEOUT_MS });
		} catch (error) {
			const timedOut = error?.code === 'ERR_CANCELED' || error?.code === 'ECONNABORTED' || error?.message === 'canceled';
			if (!timedOut) notifyGlobalError(error, 'Nepodařilo se odhlásit zařízení.');
		} finally {
			clearTimeout(timeoutId);
		}
		disconnectSocketIO();
		setFadedIn([]);
		await logoutCleanUp(brain, emptyBrain);
		navigate(`/entrance${searchParam ? `?${searchParam}` : ''}`);
		if (typeof window !== 'undefined') setTimeout(() => (window.__wipeInProgress = false), 1500);
	};

	// JSX PROPS ---------------------------------------------------
	const JSXProps = {
		loader,
		menuView,
		initialize,
		setInitialize,
		isMobile,
		location,
		brain,
		comps,
		logOut,
		nowAt,
		setMenuView,
	};

	// JXX RENDER -----------------------------------------------
	return (
		<foundation-comp class={`fadingIn ${fadedIn.includes('Foundation') ? 'fadedIn' : ''} block w100  h100 ${brain.user.id ? 'bInsetBlueDark' : ''}`}>
			<globalContext.Provider value={{ brain, isMobile, nowAt, setMenuView, setFadedIn, logOut, menuView }}>
				<LogoAndMenu {...JSXProps} location={location} setFadedIn={setFadedIn} />
				{brain.user.id && (
					<Suspense fallback={<div>Loading ...</div>}>
						<Home {...JSXProps} />
					</Suspense>
				)}
				<ScrollRestoration getKey={loc => (loc.pathname === '/' ? 'home-root' : loc.key || loc.pathname)} />
				<Outlet context={JSXProps} />
			</globalContext.Provider>
		</foundation-comp>
	);
}
export default Foundation;
