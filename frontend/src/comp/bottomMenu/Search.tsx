import { useRef, useLayoutEffect, useState, useMemo, memo, useEffect, useContext } from 'react';
import axios from 'axios';
import Masonry from '../Masonry';
import { setPropsToContent, forage, createSubsetObj } from '../../../helpers';
import { EmptyDiv } from '../EmptyDiv';
import useMasonResize from '../../hooks/useMasonResize';
import UserStrip from '../contentStrips/UserStrip';
import EventStrip from '../contentStrips/EventStrip';
import ChatStrip from '../contentStrips/ChatStrip';
import { notifyGlobalError } from '../../hooks/useErrorsMan';
import { globalContext } from '../../contexts/globalContext';

/** ----------------------------------------------------------------------------
 * SEARCH COMPONENT
 * Unified search overlay handling events, users, and chats.
 * Supports local cache fallback, category switching, and infinite scroll fetching.
 * -------------------------------------------------------------------------- */
export function Search(props) {
	// PROPS & STATE -----------------------------------------------------------
	const { isMobile } = useContext(globalContext);
	const { brain, setMenuView, isChatSetup, chatType, isInvitations, superMan, nowAt, cat: searchCat, setModes, setFadedIn, menuView, selectedItems, manageMode, chats, reset } = props;

	const searchInput = useRef();
	const [cat, setCat] = useState(searchCat || null);
	const [searchQ, setSearchQ] = useState('');
	const [content, setContent] = useState(null);
	const contentRef = useRef();
	const [showCats, setShowCats] = useState(!cat && (cat !== 'chats' || isInvitations) ? true : false);
	const target = ['users', 'links', 'trusts'].includes(cat) ? 'users' : cat;
	const [inform, setInform] = useState([]);
	const [stripMenu, setStripMenu] = useState(null);
	const [showingLocalContent, setShowingLocalContent] = useState(false);
	const fetchedPastEve = useRef(false);
	const fetchedEvents = useRef(false);
	const searchDebounce = useRef(null);

	// LAYOUT HOOKS ------------------------------------------------------------
	const contType = `${{ events: 'eve', pastEvents: 'eve', users: 'user', links: 'user', trusts: 'user', chats: 'chat' }[cat]}Strips`;
	const [numOfCols] = useMasonResize({ wrapper: contentRef, brain, contType, contLength: content?.length });

	// RESET EFFECT ------------------------------------------------------------
	useEffect(() => {
		if (reset) setContent(null), setSearchQ('');
	}, [reset]);

	// RESTORE STRIPMENU / SETUP RESET EFFECT ----------------------------------
	useLayoutEffect(() => {
		if (content === null && searchQ.length > 2) performSearch(searchQ);
		if (menuView !== 'search' && !isInvitations && !isChatSetup) setContent(null);
		if (selectedItems?.length === 0) setContent(null), setSearchQ('');
		if (brain.restoreStripMenu && menuView === 'search') setStripMenu(brain.restoreStripMenu), delete brain.restoreStripMenu;
	}, [JSON.stringify(selectedItems?.map(item => item.id)), menuView]);

	// SEARCH LOGIC ------------------------------------------------------------
	// Handles local filtering and server fetching strategies
	const performSearch = async (inp, queryServer = undefined) => {
		if (inp.length < 2) {
			setContent(null);
			return false; // no local handled
		}

		// CACHE PRE-LOAD ---
		if (cat === 'pastEvents' && !fetchedPastEve.current) {
			(brain.user.pastEve ??= {}), Object.assign(brain.user.pastEve, (await forage({ mode: 'get', what: 'past' })) || {});
			fetchedPastEve.current = true;
		} else if (brain.fastLoaded && !fetchedEvents.current)
			Object.assign(brain.events, setPropsToContent('events', (await forage({ mode: 'get', what: 'events' })) || [], brain)), (fetchedEvents.current = true);

		(brain.user.search[cat] ??= {}), (brain.user.noMore.search[cat] ??= []), (brain.user.search[cat][inp] ??= []);

		// LOCAL SEARCH STRATEGY ---
		if (!queryServer) {
			// Relevance scoring based on string matching
			const relevance = (str1, str2) => {
				let [longestMatch, match, bestIndex] = ['', '', Infinity];
				for (let i = 0; i < str1.length; i++)
					for (let j = 0; j < str2.length; j++, match = '') {
						while (i + match.length < str1.length && j + match.length < str2.length && str1[i + match.length] === str2[j + match.length]) match += str1[i + match.length];
						if (match.length > longestMatch.length || (match.length === longestMatch.length && j < bestIndex)) (longestMatch = match), (bestIndex = j);
					}
				return longestMatch.length - bestIndex / str2.length;
			};

			const normalizeString = str => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
			const checkIfIncludes = str => normalizeString(str.toLowerCase()).includes(normalizeString(inp.toLowerCase()));
			const getStrToCompare = obj => {
				if (obj.type === 'private') obj = obj.members.find(member => member.id !== brain.user.id);
				return (obj.first ? `${obj.first} ${obj.last}` : obj.title || obj.name || '').toLowerCase();
			};

			const localContent = [
				...Object.values(brain.user.search[cat] || {})
					.flat()
					.filter((obj: any) => !brain[target][obj.id] || !['basi', 'basiDeta', 'mini'].includes(brain[target][obj.id].state)),
				...(cat === 'chats' ? (chats || []) : Object.values(cat === 'pastEvents' ? brain.user.pastEve || {} : brain[target])).filter(
					(obj: any) => cat === 'chats' || (!obj.blocked && ['basi', 'basiDeta', 'mini'].includes(obj.state))
				),
			].filter((obj: any) => obj.id && checkIfIncludes(getStrToCompare(obj)));

			if (localContent.length) {
				setShowingLocalContent(true);
				setContent(
					setPropsToContent(
						target,
						localContent.sort((a, b) => {
							const [aString, bString] = [getStrToCompare(a), getStrToCompare(b)];
							const [aMatch, bMatch] = [relevance(inp, aString), relevance(inp, bString)];
							const isInSearchQ = obj => {
								const searchResults = brain.user.search[cat] || {};
								return Object.keys(searchResults).some(key => key.startsWith(inp) && searchResults[key].some(item => item.id === obj.id));
							};
							const [aInSearchQ, bInSearchQ] = [isInSearchQ(a), isInSearchQ(b)];
							const [aInter, bInter] = [
								a.inter === 'sur' ? 3 : a.inter === 'may' ? 2 : a.inter === 'int' ? 1 : 0,
								b.inter === 'sur' ? 3 : b.inter === 'may' ? 2 : b.inter === 'int' ? 1 : 0,
							];
							if (aInter !== bInter) return bInter - aInter;
							if (aInSearchQ && !bInSearchQ) return -1;
							if (!aInSearchQ && bInSearchQ) return 1;
							return aMatch !== bMatch ? bMatch - aMatch : relevance(normalizeString(inp), normalizeString(bString)) - relevance(normalizeString(inp), normalizeString(aString));
						}),
						brain
					)
				);
				return true; // handled locally
			} else setContent(null);
			if (queryServer === false || brain.user.noMore.search[cat]?.includes(inp)) return false;
		}

		// SERVER SEARCH STRATEGY ---
		try {
			let newData = (await axios.post('search', { mode: cat, searchQ: inp, offset: brain.user.search[cat]?.[inp]?.length || 0 })).data;
			if (newData.length < 20) brain.user.noMore.search[cat].push(inp);
			if (content && !newData.length) return setInform(['nothingMore']), searchInput.current.focus({ preventScroll: true }), setTimeout(() => setInform([]), 2000);

			if (cat === 'chats') {
				newData = newData.map(chat => {
					if (chat.type === 'private') {
						const [id, first, last, imgVers] = [...chat.userOrName.split(','), chat.imgVers];
						delete chat.imgVers, delete chat.userOrName;
						return { ...chat, members: [createSubsetObj(brain.user, ['id', 'first', 'last', 'imgVers']), { id, first, last, imgVers }] };
					} else return chat;
				});
			} else if (cat !== 'pastEvents') {
				newData = setPropsToContent(target, newData, brain);
			}

			if (!showingLocalContent) brain.user.search[cat][inp].push(...newData);
			else (brain.user.search[cat][inp] = newData), setShowingLocalContent(false);
			await forage({ mode: 'set', what: 'user', val: brain.user }), setContent([...brain.user.search[cat][inp]]);
		} catch (err) {
			notifyGlobalError(err, 'Nepodařilo se načíst výsledky vyhledávání.');
		}
		return false;
	};

	// JSX HELPERS -------------------------------------------------------------

	const inputJSX = (
		<input
			autoFocus={!isMobile}
			onKeyDown={e => e.key === 'Enter' && content && performSearch(searchQ, true)}
			onChange={async e => {
				const newVal = e.target.value;
				setSearchQ(newVal);
				if (searchDebounce.current) clearTimeout(searchDebounce.current);
				const handledLocally = await performSearch(newVal, false);
				if (!handledLocally && newVal.length >= 2) searchDebounce.current = setTimeout(() => performSearch(newVal, true), !newVal.includes(' ') ? 4000 : 2000);
			}}
			value={searchQ}
			type='text'
			placeholder={
				manageMode === 'manage'
					? 'Zadej jméno uživatele'
					: cat === 'users'
					? 'Zadej jméno uživatele'
					: cat === 'links'
					? 'Zadej jméno spojence'
					: cat === 'trusts'
					? 'Zadej jméno důvěrníka'
					: cat === 'chats'
					? 'Zadej jméno chatu nebo uživatele'
					: cat === 'pastEvents'
					? 'Zadej název proběhlé události...'
					: 'Zadej název události...'
			}
			className={`w100 h100 fPadHorXxs posRel zin100 mh5 hvw10 aliCen flexCol justCen marAuto ${isChatSetup ? ' noBackground bold ' : 'phXbold bgTransXs xBold '} ${
				cat === 'chats' ? 'fs14' : 'fs16'
			}`}
			ref={searchInput}
		/>
	);

	const Comp = cat === 'events' || cat === 'pastEvents' ? EventStrip : cat === 'chats' ? ChatStrip : UserStrip;
	const contentStrips = useMemo(() => {
		if (content) {
			const filteredContent =
				isChatSetup && selectedItems
					? content.filter(obj => {
							const existingItem = selectedItems.find(item => item.id == obj.id);
							return !existingItem || existingItem.del;
					  })
					: content;

			return filteredContent.map((obj, idx) => (
				<Comp
					key={obj.id || `${obj.first || obj.title}${obj.last || obj.name}`}
					{...{
						setFadedIn,
						setMenuView,
						brain,
						stripMenu,
						setStripMenu,
						nowAt,
						isChatSetup,
						isSearch: true,
						isInvitations,
						[cat === 'chats' ? 'chatMan' : 'superMan']: superMan,
						isSelected: selectedItems?.some(item => item.id === obj.id && !item.del),
						isOpened: brain.openedChat === obj.id,
						obj,
						chatType,
						isPastEvent: cat === 'pastEvents',
						manageMode,
					}}
				/>
			));
		}
	}, [content, numOfCols, selectedItems, selectedItems?.length, brain.chatSetupData?.members, chats, brain.openedChat, cat, stripMenu, manageMode, isChatSetup]);

	const catsToShow = !isInvitations ? ['users', 'events', 'pastEvents', 'links'] : isInvitations === 'userToEvents' ? ['events'] : ['links', 'users'];
	const SearchCats = () => (
		<search-cat class={` bgTrans fPadHorXxxs aliStretch zinMenu block posRel ${!isInvitations ? 'posAbs botCen' : ''} w100 textAli `}>
			{/* DIVIDER --- */}
			{cat !== 'chats' && !isInvitations && <blue-divider style={{ filter: 'saturate(1) brightness(0.6)' }} class={` hr0-5 block bInsetBlueTopXl bgTrans w100 mw160 zin1 marAuto `} />}

			{!showCats && (
				<input-wrapper class={` posRel aliStretch bgWhite sideBors h100 hvw3 mh5 w100 flexRow`}>
					{/* BACK BUTTON --- */}
					<button
						onClick={() => {
							if (isInvitations === 'userToEvents') return searchInput.current.focus({ preventScroll: true });
							cat !== 'chats' ? setShowCats(true) : setModes(prev => ({ ...prev, searchChats: !prev.searchChats }));
						}}
						className={` w20 posRel flexCol bHover iw70 imw4 bInsetBlueTopXs bBor padAllXs bold`}>
						<img
							className={'zinMenu posRel'}
							src={`/icons/${
								cat === 'users' ? 'people' : cat === 'events' ? 'event' : cat === 'pastEvents' ? 'history' : cat === 'links' ? 'indicators/0' : cat === 'trusts' ? 'types/11' : 'error'
							}.png`}
							alt=''
						/>
						<span className='fs5 bold'>
							{cat === 'users' ? 'Uživatelé' : cat === 'events' ? 'Události' : cat === 'pastEvents' ? 'Proběhlé' : cat === 'links' ? 'Spojenci' : cat === 'trusts' ? 'Důvěrníci' : 'Zpět'}
						</span>
					</button>
					{/* INPUT --- */}
					{inputJSX}
					{/* SEARCH BUTTON --- */}
					<button onClick={() => !content && performSearch(searchQ, true)} className={` w20 miw5 posRel flexCol bHover iw70 imw4 bInsetBlueTopXs bBor padAllXxs bold`}>
						<img src='/icons/search.png' alt='' className='zinMenu posRel' />
						<span className='fs5 bold'>Najít</span>
					</button>
				</input-wrapper>
			)}
			{/* CATEGORY SELECTOR MENU ----------------------------------------------------- */}
			{showCats && searchCat !== 'chats' && (
				<menu-bs class={` w100 flexCen wrap marAuto bInsetBlue posRel noBackground `}>
					{catsToShow
						.filter(
							b =>
								!['trusts', 'links'].includes(b) ||
								isInvitations ||
								(b === 'links' && (brain.user.unstableObj || brain.user).linkUsers.length) ||
								(b === 'trusts' && (brain.user.unstableObj || brain.user).linkUsers.some(link => link[1] === 'tru'))
						)
						.map(m => (
							<button
								key={m}
								onClick={() => {
									setShowCats(false);
									if (cat !== m) setContent(null), setCat(m);
									searchInput.current && searchInput.current.focus({ preventScroll: true });
								}}
								className={`fs7 boldXs textSha bHover grow bgTransXs iw33 grow ${isInvitations && nowAt !== 'event' ? 'imw4 padAllS' : 'imw10 padAllS'}`}>
								{showCats && (
									<img
										src={`/icons/${m === 'users' ? 'people' : m === 'links' ? 'indicators/0' : m === 'trusts' ? 'types/11' : m === 'pastEvents' ? 'history' : 'event'}.png`}
										alt={`${m} icon`}
									/>
								)}
								{m === 'pastEvents' ? 'proběhlé' : m === 'links' ? 'spojence' : m === 'trusts' ? 'důvěrníky' : m === 'users' ? 'uživatele' : m === 'events' ? 'události' : m}
							</button>
						))}
				</menu-bs>
			)}
		</search-cat>
	);

	// RENDER ------------------------------------------------------------------
	return (
		<search-menu
			onClick={e => setMenuView && cat !== 'chats' && e.target === e.currentTarget && setMenuView('')}
			class={` ${!isChatSetup && !isInvitations && menuView !== 'search' && cat !== 'chats' ? 'hide' : ''}  w100 block ${
				isChatSetup || selectedItems ? ' noBackground posRel' : content?.length ? 'hvh100 bInsetBlueDark bgTransXxs posRel mhvh100' : ''
			} justStart zinMax flexCol`}>
			{/* CONDITIONAL TOP ELEMENTS --- */}
			{isInvitations && <SearchCats />}
			{isChatSetup && inputJSX}

			{/* RESULTS WRAPPER --- */}
			{contentStrips && contentStrips?.length > 0 && (
				<content-wrapper
					ref={contentRef}
					onClick={e => setMenuView && e.target === e.currentTarget && setMenuView('')}
					class={` ${isChatSetup || selectedItems ? '' : 'mhvh100 hvh100 overAuto'} flexCol bInsetBlueTopXs2   selfStart posRel block w100 `}>
					{/* HEADER (TITLE) --- */}
					{content?.length > 0 && (
						<section-header class={`${!isChatSetup && !selectedItems ? 'marTopXl' : ''} flexCol marBotXs posRel textAli`}>
							{!selectedItems && (
								<span className='fs27 inlineBlock textSha marAuto xBold w100'>{`Nalezen${
									target === 'users'
										? 'í uživatelé'
										: target === 'events'
										? 'é události'
										: target === 'pastEvents'
										? 'é proběhlé události'
										: target === 'chats'
										? 'é chaty'
										: 'í spojenci'
								}`}</span>
							)}
						</section-header>
					)}

					{/* MASONRY CONTENT GRID --- */}
					<Masonry content={contentStrips} config={{ numOfCols, contType }} brain={brain} />
					{menuView !== 'search' && content && content.length > 0 && (
						<button
							onClick={() => (setContent(null), setSearchQ(''))}
							className='bgTransXs tRed shaBlue    marBotXxs bGlassSubtle  posRel borderBot     tRed zinMax downLittle  posRel padAllXs boldM fs10   boRadXxs w50 marAuto mw30  '>
							skrýt výsledky
						</button>
					)}

					{/* LOAD MORE BUTTON --- */}
					{(inform.includes('nothingMore') || (content && searchQ && !brain.user.noMore.search[cat]?.includes(searchQ))) && (
						<button
							onClick={() => !inform.includes('nothingMore') && performSearch(searchQ, true)}
							className={`${
								inform.includes('nothingMore')
									? 'tBlue borRed fsD xBold '
									: `borRed ${showingLocalContent ? 'bRed tWhite thickBors' : 'tDarkBlue'} ${
											showingLocalContent && !isChatSetup && !selectedItems && cat !== 'chats' ? 'posFix botCen marBotXxl' : ''
									  } boldM  shaTop borBot8  `
							} ${isChatSetup || isInvitations || cat === 'chats' ? 'fs12 padVerXxs mw50 posRel ' : 'fs10 mw30 padVerXxs'} w80 marAuto marTopS borBot8 zinMaXl boRadXxs textSha `}>
							{inform.includes('nothingMore') ? 'Nic dalšího už není' : showingLocalContent ? 'Tohle ne. Prohledat server ...' : 'Načíst další výsledky'}
						</button>
					)}

					{cat !== 'chats' && !isChatSetup && !selectedItems && <EmptyDiv height={`hr20`} />}
				</content-wrapper>
			)}

			{/* NO RESULTS --- */}
			{!content?.length && brain.user.noMore.search[cat]?.includes(searchQ) && (
				<no-results className={`${!isChatSetup && !isInvitations ? 'marBotXxl' : ''} bDarkRed borTop posRel zinMaXl textAli selfEnd tWhite block padAllXs w100 xBold w100 fs8`}>
					Žádné výsledky
				</no-results>
			)}

			{/* BOTTOM NAV STRIP --- */}
			{!isChatSetup && !isInvitations && <SearchCats />}
			{!isInvitations && !isChatSetup && <blue-divider class={` hr1 borTop block bInsetBlueTopXl bgTrans w100 mw160 marAuto `} />}
		</search-menu>
	);
}

export default memo(Search);
