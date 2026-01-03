import { lazy, Suspense, useState, useRef, useMemo, useEffect, memo, useCallback } from 'react';
import { catTypesStructure, showObj, sherlockObj, catsSrc } from '../../sources';
import { getFilteredContent, trim, areEqual } from '../../helpers';
import useFadeIn from '../hooks/useFadeIn';

import CatFilter from '../comp/CatFilter';
import QuickFriendly from '../comp/QuickFriendly';
import BsContView from '../comp/BsContView';
import HeaderImage from '../comp/HeaderImage';
import SortMenu from '../comp/SortMenu';
import TimesFilter from '../comp/TimesFilter';
import Content from '../comp/Content';
import BsChangeHomeView from '../comp/BsChangeHomeView';

const Filter = lazy(() => import('../comp/Filter'));
const History = lazy(() => import('../comp/History'));
const Sherlock = lazy(() => import('../comp/Sherlock'));
const Map = lazy(() => import('../comp/Map'));
const comps = ['filter', 'map', 'sherlock'];

const fadeInOpts = { mode: 'home' };

const timeLabel = {
	anytime: 'kdykoliv',
	recent: 'nedávno',
	today: 'dnes',
	tomorrow: 'zítra',
	week: 'týden',
	month: 'měsíc',
	nextMonth: 'příští měsíc',
	nextWeek: 'příští týden',
	twoMonths: '2 měsíce',
	weekend: 'víkend',
};

// IDEA separate home page to public events and private (for invited only or for users links only). This allow to completely bypass filtering of cityContent Metas. will be filtering only by small userBlocksHC data on backend. Make esure, the division is easily accessible on a single click. (decide, whether to combine private and links only or keep separate. also should ensure always visible alert, that each category has its own active events). IMPORTANT !!!!!!!!!!!!!!!!!! MUST BE DONE!!!!!!!!!!!!!!!!!!!!!!!!!!!!!. Could maybe somehow ensure - only once filtering. for example dont allow events priv change after its created. This would mean, that backend only filter once per user. (just an idea.).
// INFO instead of treating the locations as a package, we could treat the users home city separately (+ indicating he has other locations active), so that home page would be basicaly a landing page for the user's home city including posts from cities council or other interested parties. We would be directly

// TODO when there is no content, completely replace home with a "marketing and motivating landing page" include last events, if there are any.
// TODO umožnit při vytvoáření událostí výběr až 3 podtypů. Ve chvíli, kdy se bude událost
// TODO stopovat jak dlouho je uživatel na daném snapu a zobrazit to v historii, podle toho může poznat, kde se zdržel nejdéle.
// TODO put the scroll-targets into the components?
// TODO for the initial guide, record video for each component. Give use options to skip them (but present it in such a way that they will want to watch it)
// TODO for the discussion friendlyMeetings, give list of possible topics. POSSIBLY provide a seamless way to start a group chat only
// TODO add masonry above the quicksSel showing next events that the user is inter. Possibly add a button to show all events and go to gallery
// TODO create turl paths for each view, possibly, give options to copy a link for an exact snap (or just create url as snap changes)
// TODO decide whether on filter close, all types should be selected, so that filter works only when opened
// TODO implement frontend limiting for requests frequency
// IDEA helper function which console logs something only once no matter how many renders the component has

// BUG selected kritiq in sherlock, search did not show anything in users
// BUG changing from none prague user to pragu doesnt fetch any events. WTF

function Home(props) {
	// OUTLET PROPS, VARIABLES, REFS ------------------------------------------------------
	const { isMobile, brain, initialize, setInitialize, nowAt, setMenuView, loader } = props,
		[snap, setSnap] = useState(),
		snapAvail = useRef({}),
		[show, setShow] = useState(showObj),
		modify = useCallback(
			(prop, val) =>
				setShow(prev => (typeof val === 'object' ? { ...prev, ...val } : { ...prev, [prop]: val === prev[prop] ? null : val ?? (typeof prev[prop] === 'boolean' ? !prev[prop] : val) })),
			[]
		),
		[avail, { cats, types = [], time, sort }, { quick, filter, map, tools, times, sorts, sherlock, history }] = [snapAvail.current, snap || {}, show],
		// EFFECTIVE TYPE SELECTION ------------------------------------------------------
		// Raw `snap.types` can contain types that are not available for current cats/time/cities. Treat those as unselected.
		effectiveSelectedTypes = useMemo(() => types.filter(type => avail.types.includes(type)), [types, avail.types]),
		hasEffectiveTypeSelection = !avail.types?.length || effectiveSelectedTypes.length > 0,
		noMeetSel = avail.types?.length && !avail.types?.filter(type => type.startsWith('a')).some(type => types.includes(type)),
		[sherData, setSherData] = useState({ ...sherlockObj }),
		sherAvail = useMemo(() => {
			if (!show.sherlock) return;
			else return getFilteredContent({ what: 'sherAvail', brain, snap, sherData, show });
		}, [show.sherlock, brain.itemsOnMap, sherData, snap?.types, snap?.time, brain, snap, show]),
		[inform, setInform] = useState([]),
		[fadedIn, setFadedIn] = useFadeIn(fadeInOpts),
		catsWrapperRef = useRef(null),
		mapWrapperRef = useRef(null),
		toolsRef = useRef(null),
		[mapLoaded, setMapLoaded] = useState(false);

	// INITIALIZATION -------------------------------------------------------
	useEffect(() => {
		if (initialize === null || !brain.user.id) return;
		setFadedIn([]), setMenuView(''), setInform([]), snap && showMan('resetView');
		// Store homeView reference without direct mutation
		(brain.homeView = initialize), (brain.contQueueIDs = []);
		if (initialize === 'cityEvents') setSnap(setAvailOrGetAvaTypes(provideSnap('newInitSnap'), false, true));
		else if (initialize === 'topEvents') setSnap({ fetch: true, contView: 'events' });
		setInitialize(null);
	}, [initialize]);

	// GET OR FIND SNAP ------------------------------------------------
	const provideSnap = useCallback(
		mode => {
			const history = brain.user.history;
			if (mode !== 'newInitSnap')
				return history.find(histSnap => {
					if (mode === 'init') return areEqual(histSnap.cities, brain.user.curCities) && histSnap.init;
					if (mode === 'exact') return areEqual(trim(snap || {}), trim(histSnap));
					if (mode === 'last') return histSnap.last;
				});

			// NEW INIT SNAP -----------------------------------------------
			const existingInit = provideSnap('init');
			if (existingInit) return { fetch: true, ...existingInit };

			const newSnap = {
				id: history.length + 1,
				types: setAvailOrGetAvaTypes({}, true),
				cats: [...catsSrc.cz],
				cities: brain.user.curCities,
				time: 'anytime',
				sort: 'popular',
				contView: 'events',
				last: true,
				init: true,
			};
			// Avoid direct mutation - create new array
			brain.user.history = [...history, newSnap];
			return { fetch: true, ...newSnap };
		},
		[brain.user.history, brain.user.curCities, snap]
	);

	const setAvailOrGetAvaTypes = useCallback(
		(inpSnap, returnTypes, returnSnap) => {
			const { cats = [...catTypesStructure.keys()], cities = brain.user.curCities, time = 'anytime' } = inpSnap || snap || {};
			const times = ['anytime', 'recent', 'today', 'tomorrow', 'weekend', 'week', 'nextWeek', 'month', 'twoMonths'];

			const citiesAvail = cities.reduce((acc, city) => {
				Object.keys(brain.citiesTypesInTimes[city] || {}).forEach(t => {
					acc[t] = [...new Set([...(acc[t] || []), ...brain.citiesTypesInTimes[city][t]])].sort((a, b) => a - b);
				});
				return acc;
			}, {});

			const allTypesAnytime = new Set(citiesAvail['anytime'] || []);
			const allTypesInSelTime = new Set(citiesAvail[time] || []);
			const avaTypes = [...allTypesInSelTime].filter(type => cats.some(cat => catTypesStructure.get(cat).ids.includes(type))).sort((a, b) => a - b);

			if (returnTypes) return avaTypes;

			const catIdsSet = cats ? new Set(cats.flatMap(cat => catTypesStructure.get(cat).ids)) : null;
			const timeHasRelevantCats = t => {
				const types = citiesAvail[t] || [];
				if (!catIdsSet || catIdsSet.size === 0) return types.length > 0;
				return types.some(type => catIdsSet.has(type));
			};
			Object.assign(snapAvail.current, {
				cats: Array.from(catTypesStructure.keys()) // CATS AVAILABLE ACROSS ALL TIMEFRAMES ---------------------------
					.filter(cat => catTypesStructure.get(cat).ids.some(id => allTypesAnytime.has(id)))
					.sort(),
				catsInTime: Array.from(catTypesStructure.keys()) // CATS AVAILABLE IN SELECTED TIMEFRAME ---------------------------
					.filter(cat => catTypesStructure.get(cat).ids.some(id => allTypesInSelTime.has(id)))
					.sort(),
				times: times.filter(timeHasRelevantCats),
				types: avaTypes,
			});

			if (returnSnap) return inpSnap;
		},
		[brain.citiesTypesInTimes, brain.user.curCities, snap]
	);

	//  IS SHERLOCK ACTIVE? ---------------------------------------
	const isSherActive = useCallback(
		(obj = sherData) => {
			if (obj.mode === 'strict') return !areEqual(obj, { ...sherlockObj, mode: 'strict' });
			return Object.keys(obj).some(key => (['gender', 'minAge', 'maxAge'].includes(key) && obj[key]) || ['indis', 'basics', 'groups'].some(k => obj[k]?.length));
		},
		[sherData]
	);

	// SNAP MANAGER FUNCTION -------------------------------------------------
	const snapMan = useCallback(
		(inp, val, reset) => {
			console.log(inp, val, reset, 'SNAP MANAGER');
			const isSnapProp = !Object.keys(sherlockObj).includes(inp);
			let [lastSnap, newSnap, newSherlock, snapChanged, sherChanged, sherActive] = [provideSnap('last'), null, null, false, false, false];
			const lastSnapSafe = lastSnap || {};
			if (inp === 'quicks')
				(newSnap = { ...snap, types: [val.type], cats: ['Přátelské'], time: 'anytime', sort: 'earliest' }), setAvailOrGetAvaTypes(newSnap), (val = val.contView), (inp = 'fetch');
			if ((inp === 'cats' && sherlock && !val.includes('Přátelské')) || (inform.includes('noMeetSel') && val.includes('Přátelské'))) modify('sherlock', false);

			if (inp === 'fetch') {
				if (typeof val === 'object') (newSnap = val), setAvailOrGetAvaTypes(newSnap), reset && (newSherlock = { ...sherlockObj });
				else brain.canScroll = true;
			} else {
				// SETTING NEW SNAP PROPERTIES ------------------------------
				if (isSnapProp) {
					if (brain.stillShowingMapContent) delete brain.stillShowingMapContent, (brain.snapChangedWhileMapHidden = true);
					const lastAvailTypes = setAvailOrGetAvaTypes(lastSnap, 'returnTypes');
					setAvailOrGetAvaTypes((newSnap = { ...snap, [inp]: val }));
					const newTypes = newSnap.types.filter(type => avail.types.includes(type));
					const lastTypes = lastSnapSafe.types.filter(type => lastAvailTypes.includes(type));
					snapChanged = brain.snapChangedWhileMapHidden
						? true
						: !areEqual({ types: newTypes, time: newSnap.time, sort: newSnap.sort }, { types: lastTypes, time: lastSnapSafe.time, sort: lastSnapSafe.sort });
				} else {
					// SETTING NEW SHERLOCK OBJECT --------------------------
					if (val === 'strict') newSherlock = { ...sherlockObj, mode: val };
					else (newSherlock = { ...sherData, [inp]: !Array.isArray(val) ? (sherData[inp] === val ? null : val) : val.sort((a, b) => a - b) }), (sherActive = isSherActive(newSherlock));
					sherChanged = newSherlock ? !areEqual(newSherlock, snap.sherData) && (isSherActive(snap.sherData || newSherlock) ? true : sherActive) : false;
				}
			}
			// SETTING NEW SNAP -------------------------------------------
			if (newSherlock) setSherData(newSherlock);

			setSnap({
				...trim(newSnap || snap),
				...(inp === 'fetch'
					? { fetch: reset ? !areEqual(trim(provideSnap('last')), trim(newSnap)) : true, contView: typeof val === 'object' ? val.contView : val }
					: { contView: snap.contView }),
				cities: [...(typeof val === 'object' && val?.cities ? val.cities : brain.user.curCities)],
				...(show.sherlock && isSherActive() && val === 'users' && { sherData }),
				...(snapChanged && { changed: true }),
				...(sherChanged && { sherChanged: true }),
			});
		},
		[snap, show, sherlock, sherData, inform, brain, modify, provideSnap, setAvailOrGetAvaTypes, avail.types, isSherActive]
	);

	// AUTO-CLOSE SHERLOCK WHEN FRIENDLY CATEGORY IS REMOVED ---
	// Guarantees Sherlock cannot stay open when the user removes the only category it can operate on.
	useEffect(() => {
		if (!sherlock) return;
		if (cats?.includes('Přátelské')) return;
		modify('sherlock', false);
	}, [sherlock, cats, modify]);

	// SHOW MANAGER FUNCTION --------------------------------------
	const showMan = useCallback(
		(inp, val) => {
			const actions = {
				quick: () => modify('quick', val),
				tools: () => modify('tools', tools === 'expert' ? comps.reduce((acc, comp) => ({ ...acc, [comp]: false }), { tools: 'basic' }) : 'expert'),
				resetView: () => (delete brain.stillShowingMapContent, modify(null, { ...showObj, map: map ? 'hide' : false, view: initialize || 'cityEvents' })),
				homeView: () => {
					if (val === 'topEvents' && (!brain.bestOfIDs.length || !brain.bestOfIDs.some(id => brain.events[id]?.state === 'basi'))) loader.load('/?homeView=topEvents');
					else setInitialize(val);
				},
				sherlock: () => {
					if (sherlock) setSherData({ ...sherlockObj }), setSnap({ ...snap, sherData: null, sherChanged: false });
					if (!sherlock && inform.includes('noMeetSel')) return modify('sherlock', true);
					if (!inform.includes('noMeetSel') && (!cats.includes('Přátelské') || noMeetSel))
						setInform(prev => [...prev, 'noMeetSel']), setTimeout(() => setInform(prev => prev.filter(inform => inform !== 'noMeetSel')), 2000);
					else actions.default();
				},
				history: () => {
					if (brain.user.history.length === 1) setInform(prev => [...prev, 'noHistory']), setTimeout(() => setInform(prev => prev.filter(inform => inform !== 'noHistory')), 2000);
					else modify('history', history === true ? false : true);
				},
				map: () => {
					if (!hasEffectiveTypeSelection) return setInform(prev => [...prev, 'noSelEvents']), setTimeout(() => setInform(prev => prev.filter(inform => inform !== 'noSelEvents')), 2000);
					if (map === true) return modify('map', 'hide');

					// Keep track that map was loaded so we don't unmount it
					setMapLoaded(true);

					// OPEN MAP AND SCROLL TO CENTER IT (DELAY FOR SUSPENSE TO RESOLVE) ---------------------------
					modify('map', true);
					setTimeout(() => mapWrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350);
				},
				default: () => modify(inp),
			};

			const scrollToTop = inp === 'tools', // CLOSING COMPS SCROLLS TO CENTER NOW ---------------------------
				scrollToCenter = ['times', 'sorts', 'resetView'].includes(inp) || (comps.includes(inp) && show[inp] === true);

			(actions[inp] || actions.default)(),
				!isMobile &&
					(scrollToTop
						? requestAnimationFrame(() => window.scrollTo({ top: catsWrapperRef.current.offsetTop - 170, behavior: 'smooth' }))
						: scrollToCenter && requestAnimationFrame(() => setTimeout(() => toolsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)));
		},
		[snap, show, tools, map, initialize, sherlock, inform, cats, noMeetSel, history, types, hasEffectiveTypeSelection, brain, modify, loader, setSnap, setInitialize, isMobile]
	);

	// PROPS ----------------------------------------
	const jsxProps = useMemo(
		() => ({
			fadedIn,
			show,
			brain,
			snap: snap || {},
			avail,
			nowAt,
			provideSnap,
			snapMan,
			showMan,
			superMan: snapMan,
			setSnap,
			setShow,
			isMobile,
			sherData,
			setSherData,
			sherAvail,
			isSherActive,
			inform,
			map: show.map,
			initialize,
			quick,
			cats,
			time,
			types,
			tools,
			history,
			filter,
			selSort: sort,
			timeLabel,
			noMeetSel,
			setFadedIn,
			catTypesStructure,
			setAvailOrGetAvaTypes,
			setMenuView,
		}),
		[
			fadedIn,
			show,
			brain,
			snap,
			avail,
			nowAt,
			provideSnap,
			snapMan,
			showMan,
			setSnap,
			setShow,
			isMobile,
			sherData,
			setSherData,
			sherAvail,
			isSherActive,
			inform,
			initialize,
			quick,
			cats,
			time,
			types,
			tools,
			history,
			filter,
			sort,
			noMeetSel,
			setFadedIn,
			setAvailOrGetAvaTypes,
			setMenuView,
		]
	);

	return (
		<home-section class={`${nowAt !== 'home' ? 'hide' : ''} w100 block`}>
			{/* HEADER IMAGE ------------------------------------------------- */}
			<HeaderImage fadedIn={fadedIn} thisIs={nowAt} />
			{/* CHANGE VIEWS MENU ------------------------------------------- */}
			<BsChangeHomeView {...jsxProps} />

			{show.view === 'cityEvents' && snap && (
				<cities-view class={`fPadHorXxs textAli marAuto  block w100 posRel `}>
					{/* QUICK FRIENDLY ------------------------------------------------- */}

					<QuickFriendly {...jsxProps} />
					<empty-div class={`block ${quick === false ? 'hvh2' : 'hvh11'}`} />

					{/* CAT FILTER --------------------------------------------- */}
					<img src={`/icons/search.png`} className='aspect1610 w20 miw3 mw8 maskLowXs  downTinyBit posRel' alt='' />
					<span className='boldM fs13 tDarkBlue textSha marBotXxxxs block lh1'>Hlavní vyhledávač</span>
					<span className='fs8 w90 marAuto  posRel inlineBlock marBotXs '>
						Zvol si kategorie , časové období a způsob řazení. Použij pokročilé nástroje (Filter, Mapa, Sherlock) pro precizní vyvledání událostí a účastníků
					</span>
					<filtering-system ref={catsWrapperRef} class='block   w100 posRel'>
						{/* RESET BUTTON --------------------------------------------------- */}
						{(provideSnap('init')?.types.length !== types.length ||
							snap.contView !== 'events' ||
							cats.length !== catsSrc.en.length ||
							comps.some(comp => show[comp] === true) ||
							snap.sort !== 'popular' ||
							snap.time !== 'anytime') && (
							<button
								onClick={() => (snapMan('fetch', provideSnap('init'), true), showMan('resetView'))}
								className='posAbs bgTrans tShaWhiteXl  tRed opacityL  zin2500 topCen  padBotXxs xBold fs13 xBold zinMenu w33 marAuto mw20'>
								Reset
							</button>
						)}

						{/* CAT FILTER ------------------------------------------------- */}
						<CatFilter {...jsxProps} />

						{/* TOOLS STRIP------------------------------------------------- */}
						<tools-strip
							ref={toolsRef}
							id='switches'
							class={`fadingIn ${fadedIn.includes('Tools') ? 'fadedIn' : ''} ${!hasEffectiveTypeSelection ? 'borderRed' : ''} flexCol    posRel  marAuto `}>
							{!times && !sorts && (
								<toggle-buttons className='flexCen alicen spaceBet   aliStretch  bPadVerM       w100   posRel   '>
									{/* TOGGLE TIME FRAMES ---------------------------------------- */}
									{(() => {
										const noEventsInTime = !avail.times?.includes(time);
										return (
											<button
												className={`   grow  allOff  mw45   bHover h100     textSha ${noEventsInTime && avail.types.length ? 'bRed tWhite' : ''}`}
												onClick={() => showMan('times')}>
												<img src={`/icons/gallery/pastSurMay.png`} className='aspect1612  w20 miw3 mw4' alt='' />
												<span className='fs12 bold '>{timeLabel[time]}</span>
											</button>
										);
									})()}

									{/* EXPERT TOOLS TOGGLES ------------------------------------------------- */}
									<expert-toggles class='flexCen     aliStretch gapXxxs      w60 mw65 grow   zinMaXl posRel   marAuto h100  '>
										{comps
											.filter(comp => comp === 'filter' || show[comp] || (hasEffectiveTypeSelection && (comp !== 'sherlock' || (!noMeetSel && snap.cats.includes('Přátelské')))))
											.map(key => {
												const availCount = avail.types.length;
												const numOfAvailNotSel = avail.types?.filter(type => !types.includes(type)).length;
												const notAllTypesSelected = snap.types.length > 0 && availCount - numOfAvailNotSel !== availCount;
												const isSel = show[key] === true || (notAllTypesSelected && key === 'filter');

												return (
													<button
														key={key}
														onClick={() => {
															if (!avail.types.length) setInform(['noEvents']), setTimeout(() => setInform(prev => prev.filter(inform => inform !== 'noEvents')), 3000);
															else if (key !== 'sherlock' || !inform.includes('noMeetSel')) showMan(key);
														}}
														className={`${isSel && !inform.length && hasEffectiveTypeSelection ? 'fs12 arrowDown1 posRel xBold   ' : ' fs8   bHover  '}
													${!hasEffectiveTypeSelection ? 'tRed xBold fs15' : ''}
											          grow     bgTransXs posRel   lh1         `}>
														<img src={`/icons/${key}.png`} className={`aspect1612 ${isSel ? 'mw6 w45' : 'mw5 w30'}  miw4  `} alt='' />
														{key === 'filter' ? (notAllTypesSelected ? `${availCount - numOfAvailNotSel}/${availCount}` : 'filter') : key}
														{isSel && !inform.length && hasEffectiveTypeSelection && (
															<blue-divider
																style={{ bottom: '0px', filter: 'saturate(1.5) brightness(0.5)' }}
																class='hvw1 hr0-5 block posAbs botCen  zinMaXl     bInsetBlueTopXl   w100  marAuto'
															/>
														)}
													</button>
												);
											})}
									</expert-toggles>

									{/* TOGGLE SORTING --------------------------------------- */}
									<button className={`  posRel allOff  bHover grow mw45 h100  textSha`} onClick={() => showMan('sorts')}>
										<img src={`/icons/sort.png`} className='aspect1610 w20 miw3 mw4' alt='' />
										<span className='fs12 bold '>
											{sort === 'popular' ? 'oblíbené' : sort === 'earliest' ? 'brzké' : sort === 'nearest' ? 'blízké' : sort === 'intimate' ? 'intimní' : 'rušné'}
										</span>
									</button>

									<blue-divider style={{ filter: 'saturate(1)' }} class='h100 posAbs botCen   downLittle zinMax    bInsetBlueTop opacityM    w75 mw95  marAuto' />
								</toggle-buttons>
							)}

							{/* TIMES FILTER --------------------------------------- */}
							{show.times && <TimesFilter {...jsxProps} />}

							{/* SORT MENU --------------------------------------- */}
							{sorts && <SortMenu {...jsxProps} mode={'content'} />}

							{/* NO FRIENDLY SELECTED WARN ---------------------*/}
							{(inform.includes('noEvents') || (!sherlock && inform.includes('noMeetSel')) || (map !== true && inform.includes('noSelEvents')) || inform.includes('noHistory')) && (
								<span className=' tRed borderRed shaBot  textAli inlineBlock pointer marAuto marBotS  zin2500  selfEnd bInsetRedTop padAllXxs w100 mw50 boRadXxs xBold fs12'>
									{inform.includes('noEvents')
										? 'Nejsou založeny žádné události, bohužel.'
										: inform.includes('noSelEvents')
										? 'Nemáš zvolen ani jeden typ události'
										: !cats.includes('Přátelské')
										? 'Přiznač kategorii přátelských událostí'
										: inform.includes('noHistory')
										? 'Zatím jsi nepotvdil žádný filtr'
										: 'Vyber nějaké přátelské události'}
								</span>
							)}
						</tools-strip>
						{!hasEffectiveTypeSelection && (
							<span className='tWhite padAllXxs w30 mw40 bRed posAbs botCen downLittle zin2500 posRel inlineBlock boldS'>{`Ve zvolených kategoriích nemáš vybrané události. `}</span>
						)}
					</filtering-system>

					{/* SNAPS HISTORY ------------------------- */}
					{history && (
						<Suspense fallback={<div className='fadingIn'>Načítám historii ...</div>}>
							<History {...jsxProps} />
						</Suspense>
					)}
					{/* EVENT TYPES FILTER ------------------------------------------ */}
					{filter && (
						<Suspense fallback={<div className='fadingIn'>Načítám filtr ...</div>}>
							<Filter {...jsxProps} />
						</Suspense>
					)}

					{/* MAP ----------------- */}
					{(show.map !== false || mapLoaded) && (
						<Suspense fallback={<div>Loading Map...</div>}>
							<map-wrapper ref={mapWrapperRef} class='block w100' style={{ display: show.map === true ? 'block' : 'none' }}>
								<Map {...jsxProps} />
							</map-wrapper>
						</Suspense>
					)}
					{/* SHERLOCK ----------------- */}
					{sherlock && sherAvail && sherData && (
						<Suspense fallback={<div className='fadingIn'>Načítám Sherlocka ...</div>}>
							<Sherlock {...jsxProps} />
						</Suspense>
					)}

					{/* CONTENT VIEW BS -------------- */}
					<BsContView {...jsxProps} noFriendly={noMeetSel || (map && sherlock && !sherAvail.basics.length)} />
				</cities-view>
			)}
			{avail.types?.length > 0 && <Content {...jsxProps} disableResize={nowAt !== 'home'} />}
			{/* CONTENT --------------- */}
		</home-section>
	);
}

export default memo(Home, (p, n) => p.nowAt === n.nowAt && p.initialize === n.initialize && p.brain === n.brain && p.isMobile === n.isMobile);
