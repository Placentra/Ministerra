// USER PROFILE CARD ---
// Primary rendering component for user profiles in feeds and event attendee lists.
// Manages profile views, personality indicators, event attendance previews, and actions.
import { useState, memo, useRef, useEffect, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { BASIC_TOPICS, USER_GROUPS } from '../../../shared/constants';
import { humanizeDateTime } from '../../helpers';
import EventCard from './EventCard';
import RateAwards from './RateAwards';
import ContentIndis from './ContentIndis';
import { Fragment } from 'react';
import { previewEveCard } from './menuStrips/helpers';
import UserMenuStrip from './menuStrips/UserMenuStrip';

// TODO when ismobile is true, do not set specific heights to userCards, heights don´t matter on mobile

/** Get card size classes based on layout context */

const UserCard = props => {
	// PROPS AND STATE INITIALIZATION ---------------------------
	const { obj, cols, nowAt: propsNowAt, isProfile, brain: propsBrain, isMobile, selTypes, showAllThumbs, isPast, isEventPreview, eveInter, galleryMode, showActions } = props;
	const { nowAt = propsNowAt, brain = propsBrain, sherData } = useOutletContext() ?? {},
		// STABLE RANDOM FOR ASSET SELECTION ---------------------------
		stableRandom = useRef((parseInt(String(obj.id).slice(-4), 36) % 30) + 1),
		// UI MODES ---------------------------
		[modes, setModes] = useState({
			actions: showActions,
			protocol: false,
			evePreview: null,
			invite: false,
			inviteEvePreview: false,
			allEveThumbs: false,
		}),
		// INTERACTION STATUS ---------------------------
		[status, setStatus] = useState({
			embeded: isProfile,
			mark: obj.mark || null,
			awards: obj.awards || [],
			score: obj.score,
			invited: obj.invited,
			messaged: obj.messaged,
			blocked: obj.blocked,
			linked: obj.linked,
			trusts: obj.trusts,
		}),
		cardsView = props.cardsView || brain.user.cardsView.users,
		[userCardRef, actionsRef, eventPreviewRef] = [useRef(), useRef(), useRef()],
		scrollPosition = useRef(0),
		// FILTERED EVENT THUMBNAILS ---------------------------
		eveThumbsToShow = useMemo(
			() =>
				obj.eveInters?.filter(([id]) => {
					const eve = brain.events[id];
					if (!eve) return false;
					if (selTypes && !selTypes.has(eve.type)) return false;
					// Filter out past events
					if ((eve.ends || eve.starts) < Date.now()) return false;
					return true;
				}) || [],
			[obj.eveInters, brain.events, selTypes, showAllThumbs]
		),
		hasMoreEvents = eveThumbsToShow?.length > 1,
		showTopRedInfoStrip = ['evePreview', 'protocol', 'profile', 'invite'].some(button => modes[button]);

	// TEXT CLASS DEFINITION ---------------------------
	const textClass = !cols || cols <= 3 ? 'fs9' : 'fs7';

	// SHERLOCK MATCHES (PERSONA SIMILARITY) ---------------------------
	const sherlockMatches = useMemo(() => {
		if (!sherData) return {};
		return ['indis', 'groups', 'basics'].reduce((acc, key) => ({ ...acc, [key]: sherData[key].filter(id => obj[key]?.includes(id)) }), {});
	}, [sherData]);

	// AUTO SCROLL AND MODE RESET ---------------------------
	// Handles viewport centering and resets modes on excessive scrolling.
	useEffect(() => {
		if (![modes.actions, modes.evePreview].some(mode => mode)) return;
		const scrollTo = el => el.current && window.scrollTo({ top: el.current.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3 - 100, behavior: 'smooth' });
		scrollPosition.current = window.scrollY;
		let ticking = false;
		const closeWhenScroll = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				ticking = false;
				if (window.location.pathname.startsWith('/event') || modes.invite || (modes.evePreview && modes.inviteEvePreview) || showActions) return;
				const dist = Math.abs(window.scrollY - scrollPosition.current);
				if (dist > (modes.evePreview ? 800 : 500)) setModes(prev => Object.keys(prev).reduce((acc, k) => ({ ...acc, [k]: false }), {}));
			});
		};
		window.addEventListener('scroll', closeWhenScroll, { passive: true });
		modes.actions ? scrollTo(actionsRef) : modes.evePreview && scrollTo(eventPreviewRef);
		return () => window.removeEventListener('scroll', closeWhenScroll);
	}, [modes.actions, modes.evePreview, modes.protocol, modes.invite, modes.inviteEvePreview, showActions]);

	useEffect(() => {
		if (brain.scrollTo || !isProfile) return;
		// userCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
	}, []);

	// EVENT THUMBNAILS COMPONENT ---------------------------
	// Renders list of upcoming events for the user with status indicators.
	const eventsThumb = (
		<thumbs-wrapper
			onClick={() => setModes(prev => ({ ...prev, allEveThumbs: false }))}
			class={`flexRow aliEnd point ${modes.allEveThumbs ? 'w100  bgTransXs padVerXxxs   overAuto' : hasMoreEvents ? `` : cardsView !== 2 ? `miw11 marRigXx ` : ` `} ${
				modes.evePreview && hasMoreEvents ? 'padBotXs ' : ''
			}   posRel wrap  boRadXs zinMax w25 `}>
			{/* SHOW ALL BUTTON --------------------------- */}
			{!modes.allEveThumbs && hasMoreEvents && (
				<show-all
					onClick={e => (e.stopPropagation(), setModes(prev => ({ ...prev, allEveThumbs: !prev.allEveThumbs, evePreview: false, actions: false })))}
					className={`${modes.allEveThumbs ? 'noBackground padHorS posRel zinMaXl' : 'borRedSel'} block flexCol aliCen boldM shaLight boRadXxxs  posRel`}>
					<img className={`marAuto posRel boRadXs ${cardsView === 2 ? ' mw8' : 'aspect1610 upTiny mw9'}`} src={`/icons/event.png`} alt='' />
					{!modes.allEveThumbs && <span className='xBold fs8 bgTransXxs posAbs padVerXxxxs padHorXs botRight bgWhite boRadM lh1'>{eveThumbsToShow.length}</span>}
				</show-all>
			)}
			{/* INDIVIDUAL EVENT THUMBS --------------------------- */}
			{(modes.allEveThumbs || !hasMoreEvents) &&
				eveThumbsToShow
					?.filter(([id]) => brain.events?.[id])
					.sort(([idA], [idB]) => (brain.events[idA]?.starts || 0) - (brain.events[idB]?.starts || 0))
					.map(([eventID, flag]) => {
						const eventObj = brain.events?.[eventID];
						if (!eventObj) return null;
						const eventIsPast = (eventObj.ends || eventObj.starts) < Date.now();

						return (
							<single-thumb
								key={eventID}
								onClick={async e => (
									e.stopPropagation(),
									modes.evePreview?.id === eventObj.id
										? setModes(prev => ({ ...prev, evePreview: false }))
										: (await previewEveCard({ obj: eventObj, brain }), setModes(prev => ({ ...prev, evePreview: eventObj, protocol: false, invite: false })))
								)}
								className={`${modes.evePreview?.id === eventID ? 'bDarkBlue tWhite zinMaXl bsContentGlow' : 'zinMax'} flexCen ${modes.allEveThumbs ? 'grow' : ''} ${
									cols <= 4 ? 'mh6 ' : ''
								} ${cardsView === 2 ? 'mw8' : 'padRightXs'} bHover pointer bgTransXs  miw12    posRel boRadXxs`}>
								<inner-wrapper class='flexCen aliCen padLeftXxs justCen grow'>
									<img className={`${cols === 3 ? 'mw10' : cols === 4 ? 'mw7' : 'mw8 '} upTiny  posRel  w90    posRel boRadXs   `} src={`/icons/types/${eventObj.type}.png`} alt='' />
									<texts-wraper class='flexCol justCen  fPadHorXxxs    '>
										<span className={`${flag === 'sur' ? 'tGreen tSha10 xBold' : eventIsPast ? 'tGrey textSha' : 'tBlue bold'} textSha fs18 lh1`}>
											{humanizeDateTime({ dateInMs: eventObj.starts, thumbRow: 'upper' })}
										</span>
										<span className='tNoWrap fs7 bold lh1'>{humanizeDateTime({ dateInMs: eventObj.starts, thumbRow: 'bottom' })}</span>
										{/* INTERACTION BADGES --------------------------- */}
										{eventObj.inter === 'may' && obj.id !== brain.user.id && <span className='bBlue boldS fs6 flexCen boRadXxs padVerXxxxs  tWhite'>možná</span>}
										{eventObj.inter === 'sur' && obj.id !== brain.user.id && (
											<span className='bDarkGreen flexCen fs7 xBold boRadXxs bold padVerXxxxs padHorXxs tWhite'>určitě</span>
										)}
										{eventIsPast && <span className='bRed flexCen fs6 xBold boRadXxs bold padVerXxxxs padHorXxs tWhite'>minulá</span>}
									</texts-wraper>
								</inner-wrapper>
							</single-thumb>
						);
					})}
		</thumbs-wrapper>
	);

	// INDICATORS AND STATS ROW ---------------------------
	const indiRow = (
		<indi-row class={`flexRow aliCen wrap ${cardsView === 2 ? 'justCen marBotXxs' : ''}`}>
			{/* PERSONALITY INDICATORS --------------------------- */}
			<user-indicators class={`flexInline gapXxxs boRadXs padAllXxxs  marRigXs  shaBot   ${cardsView === 2 ? '' : 'bgTrans'}`}>
				{obj.indis
					?.filter(indi => indi <= 10 && indi !== 0)
					.map((indi, i) => (
						<img
							key={i}
							className={`${cardsView === 3 ? 'mw2-5 miw1-5' : cols <= 3 ? 'mw2 ' : 'mw2 miw2'} ${sherlockMatches.indis?.includes(indi) ? 'borderRed' : ''}`}
							src={`/icons/indicators/${indi}.png`}
							alt={`indi number ${i}`}
						/>
					))}
			</user-indicators>

			{/* CONTENT STATS (RATING, DISTANCE, ETC) --------------------------- */}
			<ContentIndis status={status} isCardOrStrip={true} cardsView={cardsView} brain={brain} obj={obj} cols={cols} thisIs={'user'} nowAt={'home'} />
			{Number.isFinite(obj.distance) &&
				(() => {
					const d = obj.distance;
					const label = d < 1 ? `${Math.round(d * 1000)} m` : d > 5 ? `${Math.round(d)} km` : `${d.toFixed(1)} km`;
					return <span className='fsA tGrey marLefXs marTopXxxs'>{label}</span>;
				})()}
		</indi-row>
	);

	// HANDLE CLICK ON IMAGE---------------------------------------------------------------
	const handleClick = e => {
		e.stopPropagation();
		if (isProfile) return setModes(prev => ({ ...prev, invite: false }));
		else
			setModes(prev => ({
				...prev,
				profile: false,
				allEveThumbs: false,
				invite: false,
				protocol: false,
				actions: modes.invite ? true : modes.evePreview || modes.allEveThumbs ? prev.actions : !prev.actions,
				evePreview: false,
			}));
	};

	console.log('obj', obj.imgVers);

	// JSX RETURN ----------------------------------------------------------------
	return (
		<user-cards
			ref={userCardRef}
			id={`card_${obj.id}`}
			class={`
				${isProfile ? 'mw65 marTopXs 	posRel  zinMax' : 'mw80 marBotXs'}
				${status.blocked ? 'bRed' : !status.embeded && (modes.actions || modes.evePreview) ? ' shaMega thickBors ' : !modes.actions ? 'padBotS' : ''}
			 bHover boRadXxs  shaBotLong   bgWhite  	  flexCol marAuto ${isProfile ? '' : 'marBotXs'}      grow   posRel    w100  `}>
			{/* IMAGE WRAPPER -------------------------------------------------*/}
			<image-wrapper onClick={handleClick} class={` maskTopXxs  w100 posRel `}>
				{/* IMAGE AND TOP LIGHT STRIPS --------------------------------------------------------*/}
				<div className='mih0-5 shaTop bgWhite zin100 posAbs topCen opacityS w100 aliStart' />
				<div className='mih2 shaTop  zin100 posAbs topCen opacityS w100 aliStart' />
				{showTopRedInfoStrip && (
					<info-strip class='posAbs topCen zinMaXl w100 textAli'>
						<arrow-down className='arrowDownRed posRel  zinMaXl  textAli   marAuto   inlineBlock   downLittle  s  xBold ' />
						<span className='  tRed tShaWhiteXl  padHorM padVerXxs marAuto posAbs topCen zinMaXl  textAli   padHorM marAuto  padVerXxxs inlineBlock borTop bInsetBlueTopXs  fs12  xBold '>
							zpět na profil
						</span>
					</info-strip>
				)}
				{/* USER IMAGE --------------------------- */}
				<img
					decoding='async'
					className={`w100 maskLowXs  aspect1610`}
					src={
						obj.imgVers
							? `${import.meta.env.VITE_BACK_END}/public/users/${obj.id === brain.user.id ? brain.user.id : stableRandom.current}_${obj.imgVers}.webp`
							: '/icons/placeholdergood.png'
					}
					alt=''
				/>

				{/* CARDSVIEW 1 - FULL NAME + INDICATORS STRIP -------------------------------------------------*/}
				{cardsView === 1 && !modes.protocol && !modes.invite && (
					<bottom-row class={`flexRow w100 spaceBet ${cols === 1 ? 'marBotXs ' : ''} zinMax   hvw3 noPoint posAbs marBotXxs botCen`}>
						{/* COOL-GUY INDICATOR --------------------------------------------------------------- */}

						{!modes.allEveThumbs && obj.indis?.includes(0) && (
							<cool-guy class={`shaMega w14 flexCol aliCen justCen  boRadXs bgTrans  padTopXs maskTopXs posAbs   upEvenMore zinMax `}>
								<img className='miw5 mw4   ' src={`/icons/indicators/0.png`} alt='' />
							</cool-guy>
						)}
						{nowAt !== 'event' && !isProfile && eveThumbsToShow?.length > 0 && eventsThumb}
						{!modes.allEveThumbs && (
							<left-side class='flexCol fPadHorXxs grow aliStart textLeft  posRel'>
								<span className={`${!cols || cols === 1 ? 'fs20' : cols <= 3 ? 'fs16' : cols === 4 ? 'fs14' : cols === 5 ? 'fs9' : 'fs10'} textSha  inlineBlock lh1`}>
									<strong className={'xBold'}>{obj.first + ' ' + obj.last}</strong> ({obj.age})
								</span>
								{indiRow}
							</left-side>
						)}
					</bottom-row>
				)}

				{/* CARDSVIEW 2 - CENTERED NAME + COOL-GUY + EVENT THUMBS -------------------------------------------------*/}
				{cardsView === 2 && (
					<bottom-row class='flexCol posAbs botCen aliCen justCen w100'>
						{nowAt !== 'event' && !isProfile && (
							<top-wrapper class='flexRow aliCen w100  justCen'>
								{eveThumbsToShow?.length > 0 && eventsThumb}
								{!modes.allEveThumbs && (
									<cool-guy class={' w14 miw7  flexCol aliCen justCen padAllXxxs maskLowXs posRel marLefS   bgTrans boRadXs  zinMax '}>
										<img className='miw5 mw8 w80   ' src={`/icons/indicators/0.png`} alt='' />
									</cool-guy>
								)}
							</top-wrapper>
						)}
						<span className={`${cols <= 3 ? 'fs20' : 'fs14'} textSha  textAli marAuto w100 inlineBlock lh1 textAli`}>
							<strong className={'xBold'}>{obj.first + ' ' + obj.last}</strong> ({obj.age})
						</span>
					</bottom-row>
				)}
			</image-wrapper>

			{/* ACTIONS SCROLL REF --------------------------- */}
			<actions-scroll-ref ref={actionsRef}></actions-scroll-ref>

			{/* UNDER IMAGE SECTIONS ------------------------------------------------------------- */}
			{(!isPast || modes.profile) && !modes.invite && (
				<under-image onClick={handleClick} class={`${cols === 1 ? '' : ''} posRel flexCol   zinMaX h100 wrap pointer posRel textLeft    gapXxxxs`}>
					{/* TEXTS AND TOPICS WRAPPER ------------------------------------------------------------- */}
					{!modes.evePreview && !modes.protocol && (
						<texts-wrapper class={`${cardsView === 2 ? 'textAli marTopXs ' : ''}  ${cols === 1 ? 'fs11' : 'fs7'} lh1 zinMaxXl  fPadHorXxs posRel flexCol grow`}>
							{/* EXPERT AND FAVORITE TOPICS --------------------------------------------*/}
							<favex-topics class={'inline marBotXxxs'}>
								{['exps', 'favs']
									.filter(key => obj[key] && Math.random() < 0.5)
									.map(key => (
										<topics-wraper class={`marRigXs  flexInline inline ${textClass}`} key={key}>
											<span className={`marRigS  tDarkBlue inline ${key === 'exps' ? 'boRadXxs padVerXxxxs boldM textSha' : 'boldM textSha'} ${textClass}`}>
												{key === 'exps' ? 'Expertní' : 'Oblíbené'}
											</span>
											{obj[key].map((item, index) => (
												<Fragment key={index}>
													<single-topic class={`inline ${sherlockMatches[key]?.includes(item) ? 'borderRed' : ''} boldXxs `}>{item}</single-topic>
													{index < obj[key].length - 1 && ', '}
												</Fragment>
											))}
										</topics-wraper>
									))}
							</favex-topics>

							{/*INDICATORS ROW ------------------------------------------------------------- */}
							{cardsView === 2 && indiRow}

							{/*ABOUT ME + LINKS NOTE --------------------------------------------------- */}
							{['shortDesc', 'note'].map(
								key =>
									(modes.actions || isProfile) &&
									obj[key] && (
										<span key={key} className={`lh1-1 ${textClass} block`}>
											<span className={`xBold inline  tBlue marRigXs ${textClass}`}>{key === 'shortDesc' ? 'O mně' : 'Poznámka'}</span>
											{obj[key]}
										</span>
									)
							)}

							{/*EXTRAS SECTION ------------------------------------------------------------- */}
							{(modes.actions || isProfile || isPast) && (
								<extras-sec className={`${cardsView === 2 ? 'textAli ' : ''} flexCol   `}>
									{/* GROUPS ---------------------------------------------------------------- */}
									<groups-wrapper className='block marBotXxxs w100'>
										{Array.from(USER_GROUPS).map(([categoryName, categoryMap]) => {
											const groups = obj.groups?.filter(group => categoryMap.has(String(group))) || [];
											if (groups.length > 0) {
												return (
													<div className={`marRigXs ${textClass} inline`} key={categoryName}>
														<span className={`bold ${textClass} tDarkBlue textSha marRigXs`}>{categoryName}</span>
														<span className={`marRigXs ${textClass}`}>
															{groups.map((group, idx) => {
																const groupLabel = categoryMap.get(String(group));
																return (
																	<span key={group} className={`${sherlockMatches.groups?.includes(group) ? 'borderRed' : ''} ${textClass}`}>
																		{groupLabel}
																		{idx !== groups.length - 1 ? ', ' : ' '}
																	</span>
																);
															})}
														</span>
													</div>
												);
											}
											return null;
										})}
									</groups-wrapper>
									{/*PROGRESSIVE TOPICS --------------------------------------------------------- */}
									<span className='block lh1-1 fs7  marBotXs'>
										<span className={`boldM textSha tGreen ${textClass}  marRigXs`}>Progresivní</span>
										{obj.basics?.map((topic, idx) => (
											<span key={topic} className={`${sherlockMatches.basics?.includes(topic) ? 'borderRed' : ''}`}>
												{BASIC_TOPICS.get(topic)}
												{idx < obj.basics.length - 1 ? ', ' : ''}
											</span>
										))}
									</span>
								</extras-sec>
							)}
							{/* THERE´S MORE INDICATORS --------------------------------------------------------- */}
							{!modes.actions && !isProfile && !isPast && (
								<theres-more class='block selfEnd marTopAuto  w100'>
									{obj.shortDesc?.length && <span className={`marRigXs inlineBlock marAuto ${cardsView !== 2 ? '' : 'textAli'}    bold tBlue   ${textClass}`}>{`Více o mně ↓`}</span>}
									{obj.note?.length && <span className={`marRigXs inlineBlock marAuto ${cardsView !== 2 ? '' : 'textAli'}   tDarkBlue boldXs fsA`}>{`+poznámka`}</span>}
									{obj.groups?.length > 0 && !isProfile && <span className={` miw8  boldS  inlineBlock tDarkGreen boldM ${textClass}`}>{`+${obj.groups.length} skupiny`}</span>}
								</theres-more>
							)}
						</texts-wrapper>
					)}
				</under-image>
			)}

			{/* RATING SECTION --------------------------------------------------------------- */}
			{modes.actions &&
				obj.id !== brain.user.id &&
				!modes.protocol &&
				!status.blocked &&
				!modes.evePreview &&
				!modes.invite &&
				(!isPast || eveInter === 'sur') &&
				(!isProfile || (obj.state !== 'stale' && obj.eveInters?.length > 0)) && (
					<RateAwards {...{ modes, brain, isCardOrStrip: true, thisIs: 'user', status, setStatus, setModes, obj, fadedIn: ['RatingBs'] }} />
				)}

			{/* IS YOU WARNING --------------------------------------------------------------- */}
			{modes.actions && obj.id === brain.user.id && (
				<you-warning className='boldM textAli block bGlass inlineBlock hr3 bInsetBlueXs posRel textSha fs8 tRed  marRigXs'>Tohle jsi ty. Ovládací prvky nejsou dostupné</you-warning>
			)}

			{/* USER MENU STRIP --------------------------------------------------------------- */}
			{modes.actions && obj.id !== brain.user.id && !modes.evePreview && (
				<UserMenuStrip
					obj={obj}
					brain={brain}
					modes={modes}
					status={status}
					setStatus={setStatus}
					setModes={setModes}
					isEventPreview={isEventPreview}
					isPast={isPast}
					galleryMode={galleryMode}
				/>
			)}
			{/* EVENT evePreview userCard ---------------------------------------------------------- */}
			<event-scroll ref={eventPreviewRef} />
			{modes.evePreview && nowAt === 'home' && <EventCard key={modes.evePreview.id} obj={modes.evePreview} cols={cols} brain={brain} isPreview={obj.id} setModes={setModes} />}
		</user-cards>
	);
};
function areEqual(prevProps, nextProps) {
	if (prevProps.showAllThumbs !== nextProps.showAllThumbs) {
		return false;
	}

	// Check other props
	return (
		prevProps.obj === nextProps.obj &&
		prevProps.cols === nextProps.cols &&
		prevProps.cardsView === nextProps.cardsView &&
		(prevProps.selTypes === nextProps.selTypes ||
			(prevProps.selTypes && nextProps.selTypes && prevProps.selTypes.size === nextProps.selTypes.size && Array.from(prevProps.selTypes).every(type => nextProps.selTypes.has(type))))
	);
}
export default memo(UserCard, areEqual);
