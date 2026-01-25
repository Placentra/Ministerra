// LOGO AND BOTTOM NAVIGATION ---
// Hosts the main application logo, loading indicators, and global menu system.
import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Chat from './bottomMenu/Chats/Chat';
import Menu from './bottomMenu/Menu';
import Gallery from './bottomMenu/Gallery';
import Search from './bottomMenu/Search';
import Alerts from './bottomMenu/Alerts';
import BsDynamic from './BsDynamic';
import useScrollDir from '../hooks/useScrollDir';
import useToast from '../hooks/useToast';
import { forage } from '../../helpers';
import { disconnectSocketIO } from '../hooks/useSocketIO';

// LOGO PULSE ANIMATION STYLE ---------------------------
const logoPulseStyle = document.createElement('style');
logoPulseStyle.textContent = `
@keyframes logoShimmer {
	0% { background-position: 0 0%; }
	100% { background-position: 0 100%; }
}
.logo-pulse-active {
	background: linear-gradient(to top, transparent 0%, transparent 30%, rgba(180, 220, 255, 0.36) 40%, rgba(200, 230, 255, 0.45) 50%, rgba(180, 220, 255, 0.31) 60%, transparent 70%, transparent 100%);
	background-size: 100% 300%;
	animation: logoShimmer 1s ease-in-out;
	pointer-events: none;
}
`;
if (!document.getElementById('logo-pulse-style')) {
	logoPulseStyle.id = 'logo-pulse-style';
	document.head.appendChild(logoPulseStyle);
}

// NAVIGATION STATE HELPERS ---------------------------
export function storeMenuViewState(menuView, galleryCat, stripMenuId) {
	const parts = [menuView || '', galleryCat || '', stripMenuId || ''].filter(Boolean);
	sessionStorage.setItem('menuView', parts.join('_'));
}

export function parseMenuViewState() {
	const stored = sessionStorage.getItem('menuView') || '';
	const [menuView, galleryCat, stripMenuId] = stored.split('_');
	return { menuView: menuView || null, galleryCat: galleryCat || null, stripMenuId: stripMenuId || null };
}

// LOGO AND MENU COMPONENT ---
function LogoAndMenu(props) {
	const { nowAt, loader, menuView, setMenuView, brain, setFadedIn, setInitialize, isMobile, logOut, location } = props,
		[logoSubtext, setLogoSubtext] = useState(null),
		bottomMenu = useRef(null),
		timeout = useRef(null),
		nextBackIsHome = useRef(null),
		[notifDots, setNotifDots] = useState(brain.user.alerts?.notifDots || { chats: 0, alerts: 0, archive: 0 }),
		[scrollDir, setScrollDir] = useScrollDir(),
		navigate = useNavigate(),
		{ toast, showToast } = useToast(),
		activeRequests = useRef(0),
		[pulseKey, setPulseKey] = useState(0),
		animationTimeout = useRef(null);

	// GLOBAL LOADING INDICATOR ---------------------------
	useEffect(() => {
		const ANIMATION_DURATION = 1000;
		const handleRequestActivity = e => {
			const { type, source } = e.detail || {};
			if (type === 'start') {
				activeRequests.current++;
				if (activeRequests.current === 1) {
					if (animationTimeout.current) clearTimeout(animationTimeout.current);
					setPulseKey(k => k + 1);
				}
			} else if (type === 'end') {
				activeRequests.current = Math.max(0, activeRequests.current - 1);
				if (activeRequests.current === 0 && !animationTimeout.current) {
					animationTimeout.current = setTimeout(() => {
						animationTimeout.current = null;
						setPulseKey(0);
					}, ANIMATION_DURATION);
				}
			}
			if (import.meta.env.DEV) console.log(`[LOADING] ${type} from ${source}, active: ${activeRequests.current}`);
		};
		window.addEventListener('requestActivity', handleRequestActivity);
		return () => {
			window.removeEventListener('requestActivity', handleRequestActivity);
			if (animationTimeout.current) clearTimeout(animationTimeout.current);
		};
	}, []);

	// SCROLL LOCKING ---------------------------
	useEffect(() => {
		const shouldLockScroll = menuView;
		if (nowAt !== 'home') nextBackIsHome.current = !menuView;
		else nextBackIsHome.current = false;
		const method = shouldLockScroll ? 'add' : 'remove';
		document.body.classList[method]('overHidden');
		document.documentElement.classList[method]('overHidden');
		setScrollDir('up');
		return () => (document.body.classList.remove('overHidden'), document.documentElement.classList.remove('overHidden'));
	}, [location, nowAt, menuView]);

	// LOGO ACTIONS ---------------------------
	async function logoClick() {
		const subText = { scrollUp: 'Vrácení nahoru', hideMenu: 'Skrytí menu', random: 'Ministerra je nejlepší!!!', back: 'Zpět' }[nowAt !== 'home' ? 'random' : menuView ? 'hideMenu' : window.scrollY > 50 ? 'scrollUp' : 'random'];
		if (timeout.current) clearTimeout(timeout.current);
		(setLogoSubtext(subText), Object.assign(timeout, { current: setTimeout(() => setLogoSubtext(null), 2000) }));
		const { menuView: prevMenuView, galleryCat, stripMenuId } = parseMenuViewState();
		if (brain.user.isUnintroduced) return;

		if (menuView && prevMenuView && prevMenuView !== menuView) {
			if (galleryCat) brain.showGalleryCat = galleryCat;
			if (stripMenuId) brain.restoreStripMenu = stripMenuId;
			return (setMenuView(prevMenuView), sessionStorage.removeItem('menuView'));
		}
		if (menuView && !nextBackIsHome.current) return (sessionStorage.removeItem('menuView'), setMenuView(''));
		if (nowAt === 'home') return window.scrollY > 50 ? window.scrollTo({ top: 0, behavior: 'smooth' }) : setInitialize('cityEvents');
		if (nowAt !== 'home') {
			if (prevMenuView) {
				if (galleryCat) brain.showGalleryCat = galleryCat;
				if (stripMenuId) brain.restoreStripMenu = stripMenuId;
				(setMenuView(prevMenuView), sessionStorage.removeItem('menuView'));
				return;
			} else setMenuView('');
			return brain.fastLoaded ? (window.history.replaceState({}, '', '/'), loader.load()) : navigate('/');
		}
	}

	// FILTER MANAGEMENT ---------------------------
	async function changeCities(inp) {
		setFadedIn([]);
		const [user, cities] = [brain.user, inp];
		const needCities = cities.filter(city => typeof city === 'object' || !brain.citiesEveTypesInTimes[city]);
		window.scrollTo({ top: 0, behavior: 'smooth' });
		if (needCities.length) loader.load(`/?homeView=cityEvents&newCities=${encodeURIComponent(JSON.stringify(cities))}`);
		else ((user.curCities = inp), setInitialize('cityEvents'));
	}

	// SHARED MENU PROPS ---------------------------
	const jsxProps = { brain, setMenuView, nowAt, scrollDir, setNotifDots, isMobile, logOut, changeCities, notifDots, menuView, showToast };
	const prevMenuView = sessionStorage.getItem('menuView');

	const hasNotifs = notifDots.chats > 0 || notifDots.alerts > 0 || notifDots.archive > 0;
	const notifDot = <span className={`miw2 posAbs ${menuView ? 'botCen' : 'left'} hr2 zin2500 bDarkRed round`} />;

	return (
		<logo-menu class={'posRel block bgTransXs mhvh100  zin3000'}>
			{toast}
			{/* LOGO HEADER --------------------------- */}
			<top-logo onClick={() => logoClick()} class="marAuto posFix zinMenu topCen w100  textAli ">
				<div className={`w90 mw150  trapezoid-logo-background hvh1 bBlue marAuto `} />
				<div className={`w80 mw70 flexCol aliCen pointer ${menuView ? 'bDarkPurple' : ''} upLittle trapezoid-logo-background marAuto posRel`} style={{ overflow: 'hidden' }}>
					{pulseKey > 0 && <span key={pulseKey} className="logo-pulse-active posAbs block" style={{ inset: 0, zIndex: 0 }} />}
					<h1 className={`${menuView ? 'fs12' : 'fs18'} lh1 boldM inlineBlock  marBotXxxxs posRel tWhite`} style={{ zIndex: 1 }}>
						{`${menuView ? (prevMenuView !== menuView ? 'Vrátit se' : `Zavřít ${prevMenuView === 'alerts' ? 'upozornění' : prevMenuView === 'chats' ? 'chaty' : prevMenuView === 'gallery' ? 'galerii' : prevMenuView === 'search' ? 'vyhledávání' : 'menu'}`) : 'Ministerra'}`}
					</h1>
					{logoSubtext && <span className="wordBreak  padVerXxs  w100 bGreen padHorL tWhite boldXs  textAli fsA">{logoSubtext}</span>}
					{/* LOGOUT BUTTON --------------------------- */}
					{!menuView && (
						<button className="noBackground padBotXxs xBold tBlue padHorXl bHover" onClick={e => (e.stopPropagation(), logOut())}>
							odhlásit
						</button>
					)}
				</div>
			</top-logo>

			{/* BOTTOM MENU PANELS --------------------------- */}
			{brain.user.id && (
				<bottom-menu ref={bottomMenu} class={`w100 posFix mhvh100 justEnd bgWhite botCen zinMaXl  `}>
					<Alerts {...jsxProps} />
					<Chat {...jsxProps} />
					<Menu {...jsxProps} />
					<Gallery {...jsxProps} />
					<Search {...jsxProps} />
				</bottom-menu>
			)}

			{/* ACTION OVERLAYS --------------------------- */}
			{nowAt === 'home' && !menuView && <BsDynamic {...{ nowAt, scrollDir, menuView, text: 'Založit událost', brain, setInitialize }} />}

			{/* NAVIGATION BUTTONS --------------------------- */}
			{!brain.user.isUnintroduced &&
				!menuView &&
				(() => {
					return (
						<menu-buttons
							style={{
								'--translateY': scrollDir === 'up' || !['home', 'event'].includes(nowAt) || menuView ? '0%' : `6rem`,
								transform: 'translateX(-50%) translateY(var(--translateY))',
								transition: 'transform 0.3s',
							}}
							class="flexCen trapezoid-logo-background-bot2 bgWhite gapXxxs padHorXxs boRadS zinMenu w100 mw80 marAuto hvw2 mih3 posFix botCen borTop">
							{['alerts', 'chats', 'menu', 'search', 'gallery'].map(b => (
								<button key={b} onClick={() => setMenuView(mode => (mode === b ? (sessionStorage.setItem('menuView', ''), false) : (sessionStorage.setItem('menuView', b), b)))} className={`${menuView === b ? ' posRel bDarkGreen shaMega thickBors bold' : notifDots[b] > 0 || (b === 'alerts' && notifDots.alerts > 0) ? 'bGlass borRedSel bgWhite' : ' bgWhite'} w100 bHover mhvh5 zinMax padTopXxs imw4 fs7 iw45 h100 textSha bold posRel grow `}>
									<inner-wrapper class="posRel h100 w100 overHidden">
										{b === 'menu' ? (
											<div className="flexRow gapXxxs aliCen justCen padBotXxs boRadXs h100 padHorS ">
												{brain.user.first && <span className="xBold fs8">{brain.user.first[0].toUpperCase()}</span>}
												<img className="miw4" src={brain.user.imgVers && brain.user.id ? `${import.meta.env.VITE_BACK_END}/public/users/${brain.user.id}_${brain.user.imgVers}S.webp` : '/icons/placeholdergood.png'} alt="" style={{ borderRadius: '12%', objectFit: 'cover', margin: '0 0.25rem' }} />
												{brain.user.last && <span className="xBold fs8">{brain.user.last[0].toUpperCase()}</span>}
											</div>
										) : (
											<img src={`/icons/${b}.png`} alt="" className="" />
										)}
										{(Boolean(Number(notifDots[b])) || (b === 'alerts' && Boolean(notifDots.alerts)) || (b === 'chats' && menuView !== 'chats' && Boolean(notifDots.archive))) && notifDot}
									</inner-wrapper>
								</button>
							))}
							{<empty-div class="hr2 bgWhite bgTransXxs zin0 pointer w95 botCen posAbs block" />}
						</menu-buttons>
					);
				})()}
			{menuView && hasNotifs && notifDot}
			{menuView && <empty-div onClick={() => setMenuView('')} class="hvh100 bgTransXxs maskTopXs zinMax pointer posFix w100 topCen mhvh100 block" />}
		</logo-menu>
	);
}

export default LogoAndMenu;
