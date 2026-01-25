import { useState, useEffect, lazy, Suspense } from 'react';
import { useLoaderData, useOutletContext, useNavigate } from 'react-router-dom';
import { FRIENDLY_MEETINGS, isEventPast } from '../../../shared/constants';
import { humanizeDateTime } from '../../helpers';
import Discussion from '../comp/Discussion';
import EveMenuStrip from '../comp/menuStrips/EveMenuStrip';
import ContentIndis from '../comp/ContentIndis';
import BsDynamic from '../comp/BsDynamic';
import EveActionsBs from '../comp/EveActionsBs';
import EventBadges from '../comp/EventBadges';
import EntranceForm from '../comp/EntranceForm';
import Content from '../comp/Content';
import EventHeaderImage from '../comp/EventHeaderImage';
import EventFeedbackProtocol from '../comp/EventFeedbackProtocol';
import useFadeIn from '../hooks/useFadeIn';
const Map = lazy(() => import('../comp/Map'));

// TODO cachovat odpovědi na komentáře a načítat je z paměti
// TODO display surely / maybe divider in the users section
// TODO replace redirect to SEZNAM after clicking the poloha button with our own map. put the map between the button and the text area or in some modal ?
//BUG selecting interand then navigatig away immediately diesn´t persist the inter. when selecting  inter fromma  userCard, and then nvigating into the eventPage, doesn´t show the inter either.

function Event() {
	const navigate = useNavigate();
	const obj = useLoaderData() as any,
		{ brain, nowAt, menuView, isMobile } = ((useOutletContext() as any) || {}) as any,
		[modes, setModes] = useState({ inter: false, share: false, rate: false, menu: false, protocol: false, privs: false, invites: false, feedback: false }),
		[maximizeImg, setMaximizeImg] = useState(false),
		[fadedIn, setFadedIn] = useFadeIn({ mode: 'event' }),
		// IS PAST CHECK ---
		// Steps: use centralized isEventPast to handle missing ends with default duration so ongoing meetings remain interactive.
		isPast = isEventPast(obj),
		[status, setStatus] = useState({
			messaged: false,
			copied: false,
			shared: obj.shared,
			mark: obj.mark || null,
			awards: obj.awards || [],
			canceled: obj.canceled,
			score: obj.score,
			interPriv: obj.interPriv,
			comments: obj.comments,
			inter: obj.inter,
			own: obj.own,
			isMeeting: FRIENDLY_MEETINGS.has(obj.type),
			...(brain.rateInProg?.props || {}),
		});

	useEffect(() => {
		setTimeout(() => window.scrollTo({ top: 0, behavior: 'instant' }), 0);
	}, [obj.id]); // SCROLL TO TOP ON EVENT CHANGE - AFTER SCROLL RESTORATION ---------------------------
	useEffect(() => {
		// SYNC INTER/PRIV FROM BRAIN CACHE ---------------------------
		const inProg = brain.interInProg[obj.id];
		if (!inProg) return;
		const inter = inProg.interFlag ? inProg.interFlag.slice(0, 3) : obj.inter,
			priv = inProg.priv || obj.interPriv;
		setStatus(prev => ({ ...prev, inter, interPriv: priv }));
	}, [obj.id, brain.interInProg]);

	const spanClass = 'fs12 lh1 inlineBlock marLefS  marRigXs boRadXxs padHorXs  tBlue bGlassSubtle  textSha padVerXxxxs boldM';
	const isUser = Boolean(brain.user.id);
	const isFriendly = obj.type.startsWith('a');
	const feedbackBase = obj.ends || obj.starts;
	const feedbackWindow = feedbackBase && Date.now() >= feedbackBase && Date.now() <= feedbackBase + 30 * 24 * 60 * 60 * 1000;
	const showFeedbackButton = isUser && feedbackWindow && !isFriendly && obj.inter !== 'pub';
	const isOwner = status.own || obj.owner === brain.user.id;

	return (
		<event-page key={obj.id} class="block">
			<EventHeaderImage event={obj} nowAt={nowAt} brain={brain} fadedIn={fadedIn} maximizeImg={maximizeImg} onImageClick={() => setMaximizeImg(!maximizeImg)} isMobile={isMobile} />

			<title-texts class={`${fadedIn.includes('TitleTexts') ? 'fadedIn' : ''}  zinMaxl fPadHorXs  marAuto   ${!status.isMeeting && !obj.imgVers ? 'padTopXxxl' : !maximizeImg ? 'padTopXxl' : 'padTopS'}   zinMax posRel  fadingIn flexCol  textAli  marAuto   w100`}>
				{/*  DATE, CITY, PLACE, ADDRESS ------------------------------------------------------ */}
				<date-time class="zinMax fitContent bgTrans maskLowXxs padTopXxs padBotXxxs borWhite tShaWhite  fPadHorXs      boRadXs    posRel   marAuto">
					<span className={`${new Date(obj.starts) >= new Date() ? 'tDarkBlue ' : 'tRed'} fs18   xBold inline marRigS  imw3   textSha  wrap textAli`}>{`${humanizeDateTime({ dateInMs: obj.starts })}${obj.ends ? ` - ${humanizeDateTime({ dateInMs: obj.ends })}` : ''}`}</span>

					{(obj.location?.startsWith('+') || (!obj.location && !obj.place)) && <span className={`bold marRigS fs18  inlineBlock tBlue bgTrans tSha10  flexRow textSha`}>{obj.location?.startsWith('+') ? 'někde v okolí ' : 'kdekoliv v'}</span>}

					{obj.place && <strong className="fs18 tBlue boldM">{`${obj.place}`}</strong>}

					<span className={`fs18 inline  lh1    boldXs imw3  textSha flexCen wrap textAli`}>{` ${obj.location?.slice(obj.location?.startsWith('+') ? 1 : 0) || ''} ${obj.city}`}</span>
				</date-time>

				{/* TITLE ------------------------------------------------------------------ */}
				{(obj.title || status.canceled) && (
					<span className={` fs35 tShaWhiteXl textAli zin100 xBold lh0-8  inlineBlock marAuto marBotXs miw30 textAli wordBreak`}>
						{obj.canceled && <strong className="xBold inlineBlock tRed borderRed marRigM">ZRUŠENO! </strong>}
						{obj.title}
					</span>
				)}

				{/* SHORT DESCRIPTION + BADGES --------------------------------------------- */}
				{obj.badges && <EventBadges obj={obj} nowAt={'event'} />}

				{/* MENU BUTTON ---------------------------------------------------------------*/}
				<menu-comp class={`${modes.menu ? 'marBotM' : ''} ${fadedIn.includes('Image') ? 'fadedIn' : ''} block fadingIn w100 fPadHorXs aliCen justCen    zinMaXl    block posRel  marAuto`}>
					<menu-button onClick={() => setModes(prev => ({ ...prev, menu: !prev.menu, protocol: false }))} class={`${modes.menu ? 'posRel borRed bgWhite' : 'shaBlue'} flexInline wrap borderBot bgTransXs boRadXxs pointer miw12 fitContent marAuto justCen aliCen bHover zinMaXl padHorXxs`}>
						{obj.starts < Date.now() && <span className="fs9 padVerXxxs boldM boRadXxs padHorXs bRed borBot8 tWhite tNoWrap">{humanizeDateTime({ dateInMs: obj.starts, getLabel: true, endsInMs: obj.ends })}</span>}

						{/* INDICATORS ----------------------------------------------------------------*/}
						<ContentIndis key={`${obj.id}`} status={status} modes={modes} brain={brain} obj={obj} thisIs={'event'} isCardOrStrip={false} nowAt={nowAt} />
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w100 mw4 textSha bGlassSubtle borBotLight padHorXs  posRel">
							<path fillRule="evenodd" d="M4 5h16a1 1 0 010 2H4a1 1 0 010-2zm0 6h16a1 1 0 010 2H4a1 1 0 010-2zm0 6h16a1 1 0 010 2H4a1 1 0 010-2z" clipRule="evenodd" />
						</svg>
					</menu-button>

					{/* MENU STRIP */}
					{modes.menu && (
						<>
							{modes.invites && (
								<button className=" bHover posRel bInsetBlueTopXs shaBot padHorL padVerXxs  marAuto xBold fs8  tRed" onClick={() => setModes(prev => ({ ...prev, invites: false }))}>
									zavřít pozvánky
								</button>
							)}
							<EveMenuStrip
								{...{
									modes,
									setStatus,
									nowAt,
									brain,
									setModes,
									status,
									obj,
								}}
							/>
						</>
					)}
				</menu-comp>

				{showFeedbackButton && (
					<feedback-section class={'w100 textAli marBotL fPadHorXs marAuto block posRel'}>
						{/* SHOW FEEDBACK BUTTON - HIDDEN WHEN PROTOCOL IS OPEN */}
						{showFeedbackButton && !isOwner && !modes.feedback && (
							<button className="w100 mw120 marAuto padVerM posRel boRadS tPurple boldM fs12 bInsetBlueTopXs" onClick={e => (e.stopPropagation(), setModes(prev => ({ ...prev, feedback: true, menu: false, protocol: false })))}>
								<blue-divider style={{ filter: 'saturate(1) brightness(0.8)' }} class="hr1 posAbs botCen block bInsetBlueTopXl bgTrans w90 mw180 marAuto" />
								Zúčastnil ses? Dej zpětnou vazbu!
								<span className="fs8 textSha">Byl jsi na události? Dej organizátorům zpětnou vazbu!</span>
							</button>
						)}
						{showFeedbackButton && isOwner && !modes.feedback && (
							<button className="shaCon marBotS w100 mw160 padVerXxs padHorM boRadS bGlassSubtle boldM fs8" onClick={e => (e.stopPropagation(), setModes(prev => ({ ...prev, feedback: true, menu: false, protocol: false })))}>
								Ukázat zpětnou vazbu
							</button>
						)}
						{/* PROTOCOL WITH HIDE BUTTON */}
						{modes.feedback && showFeedbackButton && (
							<protocol-wrapper class="posRel block marTopS w100">
								<button onClick={() => setModes(prev => ({ ...prev, feedback: false }))} className="posAbs bgTransXs tRed zinMenu topCen padAllXxs boldM fs9 boRadXxs w33 marAuto mw50">
									Skrýt protokol
								</button>
								<EventFeedbackProtocol obj={obj} brain={brain} onClose={() => setModes(prev => ({ ...prev, feedback: false }))} isOwner={isOwner} mode="inline" />
							</protocol-wrapper>
						)}
					</feedback-section>
				)}

				{obj.shortDesc && <span className={`${status.isMeeting ? 'marBotS' : ''} fs13 lh1-2  marTopXl marAuto textAli mw160  block fPadHorS  marAuto  `}>{obj.shortDesc}</span>}
			</title-texts>

			{/* USER CARDS ---------------------------------------------------------- */}
			{status.isMeeting && <Content key={menuView} {...{ nowAt: 'event', isMobile, snap: {}, setFadedIn, fadedIn, brain, eveInter: status.inter, event: obj }} />}

			<bottom-section style={{ clear: 'both' }} class={`fadingIn ${fadedIn.includes('Texts') ? 'fadedIn' : ''} w100 marAuto marBotM  mw160  block textAli `}>
				{obj.detail || obj.fee || obj.meetHow || obj.meetWhen || obj.takeWith || obj.contacts || obj.links || obj.organizer ? (
					<detail-section class={` flexCol mw180 marBotS marAuto`}>
						{/* DETAILED DESCRPITION ---------------------------------------------*/}
						{obj.detail && (
							<detailed-info class="fPadHorXs">
								<span className={`${!status.isMeeting ? 'marTopXxl' : 'marTopS'} fs14   padBotXYXxs mw50 w80 marAuto textSha xBold block  marBotXs`}>Detailní popis / program</span>
								<span className="fs11 lh1-3 mw180 marAuto inlineBlock marBotS">{obj.detail}</span>
							</detailed-info>
						)}

						{/* EXTRE FIELDS ------------------------------------------------ */}
						{['fee', 'meetHow', 'meetWhen', 'takeWith', 'contacts', 'links', 'organizer'].some(field => obj[field]) ? (
							<extra-fields class={`block textAli mw180 w98 marAuto fPadHorXs marBotS `}>
								{(obj.meetHow || obj.meetWhen) && (
									<event-meet class="inline">
										<span className={spanClass}>Setkání</span>
										<span className="fs11 lh1-3">{`${obj.meetWhen ? humanizeDateTime({ dateInMs: obj.meetWhen }) + `${obj.meetHow ? ' - ' : ''}` : ''}` + (obj.meetHow || '')}</span>
									</event-meet>
								)}
								{Object.entries({ fee: 'Vstupné', takeWith: 'Sebou', contacts: 'Kontakt', links: 'Odkazy', organizer: 'Pořadatel' }).map(([key, val]) => {
									const ElemName = `${key}-field`;
									return obj[key] ? (
										<ElemName key={key} class="inline">
											<span className={spanClass}>{val}</span>
											<span className="fs11 lh1-3 wordBreak">{obj[key]}</span>
										</ElemName>
									) : null;
								})}
							</extra-fields>
						) : null}
					</detail-section>
				) : (
					<empty-div class={'block hr4'} />
				)}
			</bottom-section>

			{/* ACTION BUTTONS SECTION ----------------------------------------------- */}
			<buttons-section class={`fadingIn ${fadedIn.includes('RatingBs') ? 'fadedIn' : ''} block ${showFeedbackButton ? '' : ''}   w95 mw160    posRel marAuto`}>
				<EveActionsBs {...{ fadedIn: ['BsEvent'], brain, isPast, nowAt, obj, status, setStatus, modes, setModes, thisIs: 'event' }} />

				{modes.map && (
					<Suspense fallback={<map-placeholder class="block w100 hvh50 marTopXs shaTop boRadS bgTrans" />}>
						<Map singleEvent={obj} brain={brain} map={true} />
					</Suspense>
				)}
			</buttons-section>

			{/* DISCUSSION SECTION AND DYNAMIC BS --------------------------------------------------- */}
			{isUser && <BsDynamic {...{ nowAt, fadedIn: ['Menu'], setFadedIn, menuView }} />}
			{isUser && <Discussion {...{ fadedIn, obj, status, brain, setStatus }} />}

			{/* LOGIN / REGISTER FOR NON-USERS ------------------------------------------- */}
			{!isUser && (
				<>
					<EntranceForm fadedIn={fadedIn} setFadedIn={setFadedIn} nowAt={nowAt} />
					<img src="/icons/home.png" className=" posFix botCen marBotL posRel zinMaXl mw14" alt="" />
					<button onClick={() => navigate('/entrance')} className={`shaTop w100 mw100 bDarkBlue tWhite boRadXs borBot2  posFix botCen zinMaXl marBotXxs borderTop bor2 boRadXs padVerS marAuto`}>
						<span className="tWhite boldM fsF">Jít na domovskou stránku</span>
						<span className="tWhite fs8">
							... jsi tu poprvé? Tak vytvoř účet a <strong className="tWhite">běž objevit všechny funkce Ministerrau.</strong> A že jich je!
						</span>
					</button>
				</>
			)}
		</event-page>
	);
}

export default Event;
