import { useRef, useState, useLayoutEffect, useMemo, memo } from 'react';
import axios from 'axios';
import { extractInteractions, forage, setPropsToContent } from '../../../../helpers';
import { notifyGlobalError } from '../../../hooks/useErrorsMan';
import SortMenu from '../../SortMenu';
import useMasonResize from '../../../hooks/useMasonResize';
import Masonry from '../../Masonry';
import useCentralFlex from '../../../hooks/useCentralFlex';
import EventStrip from '../../contentStrips/EventStrip';
import UserStrip from '../../contentStrips/UserStrip';

// CONFIGURATION ---------------------------------------------------------------
const modeTexts = {
	futuOwn: { full: 'Budoucí vlastní', desc: 'Události (včetně všech dnešních), které administruješ či pořadáš.' },
	futuSurMay: { full: 'Zúčastníš se', desc: 'Události, kterých máš v plánu se účastnit určitě a nebo možná' },
	futuInt: { full: 'Sledované události', desc: 'Události, které Tě zaujali, ale nemá v plánu se jich účastnit.' },
	links: { full: 'Propojení uživatelé', desc: '(VČETNĚ DŮVĚRNÝCH) Uživatelé s nimiž jsi v užším kontaktu' },
	trusts: { full: 'Důvěrné propojení', desc: 'Uživatelé, které máš ze všech nejraději a v důvěrném propojení' },
	requests: { full: 'Žádosti o propojení', desc: 'Přehled všech žádostí o spojení, které jsi obdržel a nebo odeslal.' },
	invitesIn: { full: 'Přijatá pozvání', desc: 'Pozvání na události, která jsi obdržel od jiných uživatelů.' },
	invitesOut: { full: 'Odeslaná pozvání', desc: 'Pozvání na události, která jsi odeslal jiným uživatelům.' },
	pastOwn: { full: 'Minulé vlastní', desc: 'Události od včera do minulosti vytvořené či pořádané tebou.' },
	pastSurMay: { full: 'Zúčastnil ses', desc: 'Události, kterých si se účastnil konané od včera do minulosti.' },
	pastInt: { full: 'Minulé sledované', desc: 'Události, které tě zajímaly, konané od včera do minulosti.' },
	blocks: { full: 'Blokovaní uživatelé', desc: 'Uživatelé, které jsi zablokoval' },
};

/** ----------------------------------------------------------------------------
 * GALLERY COMPONENT
 * Manages display of user's events, connections, and invites in a masonry layout.
 * Handles local filtering of state data + server pagination (fetching/sorting).
 * -------------------------------------------------------------------------- */
function Gallery({ brain, setMenuView, nowAt, isMobile, menuView, mode: directMode, superMan, isInvitations, selectedItems }: any) {
	// STATE & REFS ------------------------------------------------------------
	const linkUsers = (brain.user.unstableObj || brain.user).linkUsers || [];
	const [selSort, setSelSort] = useState(directMode || isInvitations ? 'recent' : null);
	const [mode, setMode] = useState(directMode);

	// Derived bools for mode type to simplify logic
	const [isEvents, isPast, isInvites] = useMemo(() => [['futu', 'past'].some(s => mode?.includes(s)) || isInvitations === 'userToEvents' || ['invitesIn', 'invitesOut'].includes(mode), mode?.startsWith('past'), ['invitesIn', 'invitesOut'].includes(mode)], [mode, isInvitations]);

	const [content, setContent] = useState(null);
	const [emptyNotice, setEmptyNotice] = useState('');
	const [show, setShow] = useState((!mode || isInvitations) && 'menu');
	const [inform, setInform] = useState([]);
	const [stripMenu, setStripMenu] = useState(null);

	const locally = useRef();
	const wrapperRef = useRef();
	const fetchedPastEve = useRef(false);
	const fetchedMode = useRef({});
	const galleryTimers = useRef({});
	const lastOpenedRef = useRef({});
	const emptyNoticeTimer = useRef(null);

	const target = isEvents ? 'events' : 'users';
	const unstableObj = brain.user.unstableObj;
	const noMoreForMode = mode ? brain.user.noMore.gallery[mode] : isInvitations ? !content?.length : null;
	brain.user.galleryOpenCounts ||= {};

	// LAYOUT HOOKS ------------------------------------------------------------
	const [numOfCols] = useMasonResize({ wrapper: wrapperRef, brain, contType: isEvents ? 'eveStrips' : 'userStrips', deps: [content?.length, mode], contLength: content?.length || 1 });
	const catWidth = useCentralFlex('galleryCats', [menuView], null, Object.keys(modeTexts).filter(k => !isInvitations || (isInvitations === 'userToEvents' ? ['futuOwn', 'futuSurMay'].includes(k) : ['links', 'trusts'].includes(k))).length, wrapperRef);

	// RESET GALLERY MODE ------------------------------------- */}
	// If user opens the same mode multiple times after all content fetched, we remove the "all content fetched" flag to allow for refetch, presuming the user knows that there is more content to fetch.
	const resetGalleryMode = k => {
		if (!k) return;
		clearTimeout(galleryTimers.current[k]);
		delete galleryTimers.current[k];
		brain.user.galleryIDs[k] = {};
		delete brain.user.noMore.gallery[k];
		brain.user.galleryOpenCounts[k] = 0;
	};

	// MARK NO MORE CONTENT ------------------------------------- */}
	// Flags mode as fully loaded to prevent further server requests for 10 mins.
	const markNoMore = k => {
		brain.user.noMore.gallery[k] = Date.now();
		brain.user.galleryOpenCounts[k] = 0;
		clearTimeout(galleryTimers.current[k]);
		galleryTimers.current[k] = setTimeout(() => resetGalleryMode(k), 6e5); // 10 mins
	};

	// SORT CONTENT ------------------------------------- */}
	// Applies sorting logic based on current 'selSort' mode (time, rank, alpha).
	const sortContent = (items, sort = selSort) => {
		const calcRank = e => 3 * (e.surely || 0) + (e.maybe || 0) + 0.2 * (e.score || 0);

		if (isInvites) {
			const map = { recent: (a, b) => b.created - a.created, oldest: (a, b) => a.created - b.created, earliest: (a, b) => a.starts - b.starts, latest: (a, b) => b.starts - a.starts };
			return items.sort(map[sort] || ((a, b) => (b.rank || calcRank(b)) - (a.rank || calcRank(a))));
		}
		if (isEvents) {
			const map = { earliest: (a, b) => a.starts - b.starts, oldest: (a, b) => a.starts - b.starts, latest: (a, b) => b.starts - a.starts, recent: (a, b) => b.starts - a.starts };
			return items.sort(map[sort] || ((a, b) => (b.rank || calcRank(b)) - (a.rank || calcRank(a))));
		}
		if (!['first', 'last'].includes(sort)) {
			const linksMap = new Map(linkUsers.map((linkUserRow: any[], index: number) => [linkUserRow[0], { idx: index, tru: linkUserRow[1] ? 1 : 0 }]));
			return items.sort((a, b) => {
				const [lA, lB] = [linksMap.get(a.id) as any, linksMap.get(b.id) as any];
				if (!lA || !lB) return 0;
				return lA.tru !== lB.tru ? lB.tru - lA.tru : sort === 'recent' ? lB.idx - lA.idx : lA.idx - lB.idx;
			});
		}
		return items.sort((a, b) => a[sort].localeCompare(b[sort]));
	};

	// INIT & CLEANUP ------------------------------------- */}
	// Handles mode switching, menu state restoration, and auto-reset logic.
	useLayoutEffect(() => {
		if (menuView !== 'gallery' && !isInvitations && !directMode && !brain.showGalleryCat) {
			(delete brain.showGalleryCat, setMode(null), setContent(null), setShow('menu'), setSelSort(null));
		} else if (brain.showGalleryCat && !mode) {
			(setShow(null), setSelSort(mode?.startsWith('futu') ? 'earliest' : 'recent'), setTimeout(() => setMode(brain.showGalleryCat), 0));
		}

		if (brain.restoreStripMenu && menuView === 'gallery') (setStripMenu(brain.restoreStripMenu), delete brain.restoreStripMenu);

		if (mode && menuView === 'gallery') {
			const last = lastOpenedRef.current[mode] || 0;
			if (brain.user.noMore.gallery[mode] && Date.now() - last > 500) {
				lastOpenedRef.current[mode] = Date.now();
				if ((brain.user.galleryOpenCounts[mode] = (brain.user.galleryOpenCounts[mode] || 0) + 1) >= 3) resetGalleryMode(mode);
			}
			if (!selSort) setSelSort(mode.startsWith('futu') ? 'earliest' : 'recent');
			else man();
		}
	}, [mode, selSort, menuView]);

	useLayoutEffect(() => () => Object.values(galleryTimers.current).forEach(clearTimeout), []);

	// EMPTY NOTICE ---
	// Displays feedback when a category has no items.
	useLayoutEffect(() => {
		const isEmpty = Boolean(content && !content.length && noMoreForMode);
		if (isEmpty) {
			setEmptyNotice(`Žádné položky v sekci ${modeTexts[mode]?.full || 'galerie'}`);
			if (isInvitations) (setShow('menu'), setMode(null));
			clearTimeout(emptyNoticeTimer.current);
			emptyNoticeTimer.current = setTimeout(() => setEmptyNotice(''), 3000);
		} else {
			(setEmptyNotice(''), clearTimeout(emptyNoticeTimer.current));
		}
		return () => clearTimeout(emptyNoticeTimer.current);
	}, [Boolean(content && !content.length && noMoreForMode)]);

	// MANAGER (FETCHING & DATA PROCESSING) ------------------------------------
	// Main data handler: Switches modes, checks local cache, fetches from server,
	// merges new data, applies filters, and updates global 'brain' state.
	async function man(inp = undefined, val = undefined) {
		try {
			// HANDLE INPUT SWITCHES ------------------------------------- */}
			if (inp === 'selMode') return val !== mode ? (setMode(val), setSelSort(val.startsWith('futu') ? 'earliest' : 'recent'), setShow(null), setContent(null)) : setShow(null);
			if (inp === 'sort') {
				(setSelSort(val || selSort), setShow(null));
				return brain.user.noMore.gallery[mode] ? setContent(sortContent(content, val || selSort)) : setContent(null);
			}

			(setInform(p => [...new Set([...p, 'rendering'])]), (brain.user.galleryIDs[mode] ??= {}), (brain.user.pastEve ??= {}));

			// DATA SOURCE PREP ------------------------------------- */}
			const [itemsSrc, gotAll] = [isPast ? brain.user.pastEve : brain[target], brain.user.noMore.gallery[mode]];
			const ids = gotAll ? brain.user.galleryIDs[mode] : brain.user.galleryIDs[mode][selSort] || [];

			if ((isPast && !fetchedPastEve.current) || (ids.length && !fetchedMode.current[mode])) {
				const missing = isPast && ids.length ? ids.filter(id => !brain[target][id]) : !isPast && ids.length ? ids.filter(id => !brain[target][id]) : null;
				const data = await forage({ mode: 'get', what: isPast ? 'past' : target, ...(missing && { id: missing }) });
				Object.assign(itemsSrc, Array.isArray(data) ? data.reduce((a, i) => ((a[i.id] = i), a), {}) : data || {});
				isPast ? (fetchedPastEve.current = true) : (fetchedMode.current[mode] = true);
			}

			// GET LOCAL CONTENT (Strategy Pattern) ------------------------------------- */}
			if (!content) {
				if (!ids.length || locally.current) {
					if (!ids.length && gotAll) return setContent([]);

					const check = (i, s) => s.some(x => i.state?.includes(x));
					let usable = [];
					const filters = {
						futuOwn: i => i.own,
						futuSurMay: i => ['sur', 'may'].includes(i.inter),
						futuInt: i => i.inter === 'int',
						invitesIn: i => (i.invites?.in?.length || 0) > 0,
						invitesOut: i => (i.invites?.out?.length || 0) > 0,
						pastOwn: i => i.own,
						pastSurMay: i => ['sur', 'may'].includes(i.inter),
						pastInt: i => i.inter === 'int',
						blocks: i => i.blocked,
						links: i => i.linked === true || i.trusts,
						trusts: i => i.trusts,
					};

					Object.values(itemsSrc as any).forEach((item: any) => {
						const validState = isEvents ? isPast || (check(item, ['mini', 'basi']) && (item.inter || item.own || item.invites)) : item[mode === 'blocks' ? 'blocked' : 'linked'] && check(item, ['mini', 'basi']);
						if (validState && (!filters[mode] || filters[mode](item))) usable.push(item);
					});

					if (usable.length) return ((locally.current = !gotAll && !ids.length), setContent(sortContent(usable)), setInform(p => p.filter(i => i !== 'rendering')));
					locally.current = false;
				} else if (inp !== 'fetchAxi' && ids.length) {
					return (setContent(ids.reduce((a, id) => a.concat(itemsSrc[id]), []).filter(Boolean)), setInform(p => p.filter(i => i !== 'rendering')));
				}
			}

			// SERVER FETCH ------------------------------------- */}
			let newData = ((await (axios.post('gallery', { mode, offset: locally.current ? null : ids.length, sort: selSort }) as any).catch((error: any) => (notifyGlobalError(error, 'Nepodařilo se načíst galerii.'), { data: [] }))) as any).data;
			if (!newData) return;

			if (newData.length) brain.user.galleryIDs[mode][selSort] = [...(ids || []), ...newData.map(i => i.id || 'pH').filter(id => !new Set(ids).has(id))];
			else {
				(markNoMore(mode), (brain.user.galleryIDs[mode] = brain.user.galleryIDs[mode]?.[selSort] || []));
				if (content) {
					setInform(p => [...new Set([...p.filter(i => i !== 'rendering'), 'nothingMore'])]);
					setTimeout(() => setInform(p => p.filter(i => i !== 'nothingMore')), 2000);
				} else setContent([]);
				return;
			}

			// MERGE & HYDRATE ------------------------------------- */}
			const dataNoPHs = newData.filter(i => i.id);
			if (unstableObj && !isPast && !isInvites) extractInteractions(dataNoPHs, target, brain, false);

			if (!isPast && !isInvites) {
				const missing = dataNoPHs.filter(i => !itemsSrc[i.id]).map(i => i.id);
				if (missing.length) (await forage({ mode: 'get', what: isEvents ? 'events' : 'users', id: missing })).forEach(i => (itemsSrc[i.id] = i));
			}

			const now = Date.now();
			const existIds = new Set((locally.current ? [] : content || []).map(i => i.id));

			const processedNew = dataNoPHs
				.filter(i => !existIds.has(i.id) && (!isEvents || (!isPast ? new Date(i.starts).getTime() >= now : new Date(i.starts).getTime() < now)))
				.map(item => {
					['created', 'starts', 'ends'].forEach(k => item[k] && (item[k] = new Date(item[k]).getTime()));

					if (mode === 'requests') {
						const first = [brain.user.id, item.id].sort()[0] === brain.user.id;
						item.linked = (first && item.who === 2) || (!first && item.who === 1) ? 'in' : 'out';
						delete item.who;
					} else if (isInvites) brain.user[mode][item.id] = Array.isArray(item.invites) ? item.invites.filter(Boolean) : item.invites;

					const exist = itemsSrc[item.id];
					const final = Object.assign(
						{
							...(exist || {}),
							...(mode === 'trusts' && { trusts: true, linked: true }),
							...(mode === 'links' && { linked: true }),
							...(mode === 'blocks' && { blocked: true }),
							...(!['blocks', 'links', 'trusts'].includes(mode) && setPropsToContent(isEvents ? 'events' : 'users', [item], brain)[0]),
						},
						{ state: !exist || exist.state === 'meta' ? 'mini' : exist.state, ...((isInvites || isEvents) && { sync: now }) }
					);

					itemsSrc[item.id] = final;
					return final;
				});

			const newContent = [...(locally.current ? [] : content || []), ...processedNew];

			// CHECK COMPLETION & OPPOSITE SORT ------------------------------------- */}
			if (newData.length < 20) {
				(markNoMore(mode), (brain.user.galleryIDs[mode] = newContent.map(i => i.id)));
				if (inp === 'fetchAxi') {
					setInform(p => [...new Set([...p.filter(i => i !== 'rendering'), 'nothingMore'])]);
					setTimeout(() => setInform(p => p.filter(i => i !== 'nothingMore')), 2000);
				}
			} else if (['earliest', 'latest', 'recent', 'oldest'].includes(selSort)) {
				const opp = { earliest: 'latest', latest: 'earliest', recent: 'oldest', oldest: 'recent' }[selSort];
				if (newContent.some(i => brain.user.galleryIDs[mode][opp]?.includes(i.id))) {
					const add = brain.user.galleryIDs[mode][opp].filter(id => id !== 'pH' && !newContent.some(i => i.id === id)).map(id => itemsSrc[id]);
					(newContent.push(...sortContent(add)), markNoMore(mode), (brain.user.galleryIDs[mode] = newContent.map(i => i.id)));
				}
			}

			await forage({ mode: 'set', what: 'user', val: brain.user });
			await forage({ mode: 'set', what: isPast ? 'past' : target, val: newContent.filter(i => new Set(dataNoPHs.map(x => x.id)).has(i.id)) });
			locally.current = false;
			setContent(newContent);
		} catch (e) {
			import.meta.env.DEV && console.error('Gallery error:', e);
		} finally {
			setInform(p => p.filter(i => i !== 'rendering'));
		}
	}

	// JSX ELEMENTS ------------------------------------------------------------
	const Comp = isEvents ? EventStrip : UserStrip;
	const contentStrips = useMemo(
		() =>
			(content || [])
				.filter(i => !isInvitations || !selectedItems?.some(s => s.id === i.id))
				.map((obj, i) => (
					<Comp
						key={obj.id || i}
						{...{
							obj,
							stripMenu,
							setStripMenu,
							superMan,
							numOfCols,
							isInvitations,
							galleryMode: mode,
							isCardOrStrip: true,
							isSelected: selectedItems?.some(s => s.id === obj.id),
							setGalleryContent: setContent,
							brain,
							isMobile,
						}}
						logo
					/>
				)),
		[content, mode, selSort, stripMenu, selectedItems, numOfCols]
	);

	const showFetchBtn = inform.includes('nothingMore') || (content?.length > 0 && !brain.user.noMore.gallery[mode] && !inform.includes('rendering'));

	// CONTENT WRAPPER COMPONENT -----------------------------------------------
	// Wraps masonry grid and fetch buttons. Handles centering and scrolling.
	const ContentWrapper = () => (
		<content-wrapper ref={wrapperRef} onClick={e => e.target === e.currentTarget && e.target.nodeName === 'CONTENT-WRAPPER' && setMenuView('')} class={` ${!selectedItems && !isInvitations ? 'h100' : ''} block flexCol aliCen overAuto justCen w100 marAuto posRel`}>
			{/* CATEGORY TITLE ------------------------------------- */}
			{!isInvitations && <section-title class={`block  textAli ${directMode ? '' : 'marTopL '}`}>{!directMode && <span className="fs30 inlineBlock  textSha marAuto xBold w100">{modeTexts[mode]?.full || 'Tvoje profilové úložiště'}</span>}</section-title>}
			{content?.length > 0 && <Masonry content={contentStrips} config={{ contType: isEvents ? 'eveStrips' : 'userStrips', numOfCols, noPadTop: isInvitations }} brain={brain} />}
			{showFetchBtn && (
				<button onClick={() => !inform.includes('nothingMore') && man('fetchAxi')} className={`${inform.includes('nothingMore') ? 'tRed bInsetBlueTopXs bBor2 fsD xBold' : `${locally.current && !isInvitations ? 'posFix botCen bRed tWhite marBotXxl' : 'bInsetBlueTopXs bBor boRadXxs tDarkBlue textSha posRel'} xBold zinMaXl`} w80 marAuto fs10 mw60 padVerXs  textSha marBotS marTopM zinMenu`}>
					{inform.includes('nothingMore') ? 'Nic dalšího už není' : locally.current ? (contentStrips?.length > 0 ? 'Tohle ne. Prohledat server ...' : 'Prohledat ještě server ...') : 'Načíst další výsledky'}
				</button>
			)}
			{!directMode && !isInvitations && <empty-div class="hr16 block" />}
		</content-wrapper>
	);

	console.log(numOfCols, 'cols gallery');
	// RENDER ------------------------------------------------------------------
	return (
		<gallery-menu class={`boRadXs ${menuView !== 'gallery' && !directMode && !isInvitations ? 'hide' : ''} ${!directMode && !isInvitations ? 'hvh100 mihvh100 shaMega bgWhite' : 'noBackground'} flexCol ${!isInvitations ? 'overAuto bInsetBlueDark' : ''}	 justStart zinMaXl w100 aliCen ${isInvitations && mode && contentStrips?.length ? 'marBotXxxl' : ''}`}>
			{!isInvitations && <ContentWrapper />}

			{/* BOTTOM MENU SECTION ------------------------------------- */}
			{(!directMode || isInvitations) && (
				<bottom-section class={` aliStretch zinMaXl padBotXxs   w100  textAli`}>
					{/* EMPTY STATE NOTICE ------------------------------------- */}
					{emptyNotice && !show && (!directMode || isInvitations) && <div className="bRed tWhite padAllXxs w100 xBold w100 fs8">{emptyNotice}</div>}
					<inner-wrapper class="overAuto  shaTop posRel">
						{/* SUB-MENU (CATEGORY SELECTION) ------------------------------------- */}
						{show === 'menu' ? (
							<menu-bs class="w100 flexCen wrap marAuto  posRel aliStretch shaTop bgTransXs">
								{(!isInvitations ? ['futuOwn', 'futuSurMay', 'futuInt', 'links', 'trusts', 'requests', 'invitesIn', 'invitesOut', 'pastOwn', 'pastSurMay', 'pastInt', 'blocks'] : isInvitations === 'userToEvents' ? ['futuOwn', 'futuSurMay'] : ['links', 'trusts']).map(m => (
									<button key={m} onClick={() => (man('selMode', m), setShow(false))} style={{ width: isInvitations ? '50%' : '100%', ...(catWidth && { maxWidth: `${catWidth}px` }) }} className={`${show === 'menu' && mode === m ? 'bDarkBlue tWhite xBold ' : ''} bHover grow imw6 imiw4 padAllXxxs`}>
										<inner-wrapper class="bInsetBlueTopXs iw25 gapXxs shaBlueLight bBor padAllS flexCol aliCen justCen posRel w100 h100">
											<img src={`/icons/gallery/${m}.png`} alt={`${m} icon`} />
											<span className={`${numOfCols > 3 ? 'boldM fs14' : 'boldM fs9'} textSha`}>{modeTexts[m]?.full}</span>
											<span className="fs7 fPadHorXs lh1">{modeTexts[m]?.desc}</span>
										</inner-wrapper>
									</button>
								))}
							</menu-bs>
						) : show === 'sortMenu' ? (
							// SORT MENU ------------------------------------- */}
							<SortMenu mode={mode} nowAt={nowAt} brain={brain} superMan={man} selSort={selSort} isGallery={true} />
						) : (
							// TOGGLE BUTTONS (CATEGORY / SORT) ------------------------------------- */}
							<cat-bs class={`flexCen marAuto posRel ${isInvitations ? 'arrowDown1 borderBot' : ''} w100`}>
								{['cat', 'sort']
									.filter(m => m === 'cat' || content?.length > 1)
									.map(m => (
										<button key={m} onClick={() => setShow(m === 'cat' ? 'menu' : 'sortMenu')} className="bgTrans xBold posRel padTopS padBotM textSha bHover bInsetBlueTopXs bBor grow">
											<span className="fs8 marBotXxxs boldXs">{m === 'cat' ? (!content?.length ? 'Změnit kategorii' : 'kategorie') : 'seřazení'}</span>
											<span className={`${!isInvitations ? 'fs20' : 'fs8'} xBold`}>
												{m === 'cat'
													? modeTexts[mode]?.full
													: `od ${
															{
																earliest: 'nejbližších',
																oldest: 'nejstarších',
																latest: 'vzdálených',
																recent: isEvents ? 'nedávných' : 'nejnovějších',
																score: 'oblíbených',
																first: 'jména',
																last: 'příjmení',
															}[selSort]
														}`}
											</span>
										</button>
									))}
							</cat-bs>
						)}
					</inner-wrapper>
				</bottom-section>
			)}

			{isInvitations && <ContentWrapper />}
		</gallery-menu>
	);
}

const arePropsEqual = (p, n) => p.menuView === n.menuView && p.selectedItems === n.selectedItems && (p.brain.user.unstableObj || p.brain.user).linkUsers?.length === (n.brain.user.unstableObj || n.brain.user).linkUsers?.length;
export default memo(Gallery, arePropsEqual);
