import { forage, delUndef, inflectName, fetchOwnProfile, getTimeFrames } from '../../helpers';
import { catsSrc, catTypesStructure, eventTitles } from '../../sources';
import { MAX_EVENT_DURATIONS } from '../../../shared/constants';
const extraFieldsSrc = { cz: ['Detail', 'Sraz', 'Kontakt', 'Vstupné', 'S sebou', 'Odkazy', 'Pořadatel'], en: ['detail', 'meet', 'contacts', 'fee', 'takeWith', 'links', 'organizer'] };
const friendlyMeetingsHeaders = new Map(
	Object.entries({
		a1: 'venku',
		a2: 'na pivku',
		a3: 'na kávě',
		a4: 'u her',
		a5: 'uvnitř',
		a6: 'na pařbě',
		a7: 'na diskuzi',
		a8: 'anglicky',
		a9: 'na cvičení',
		a10: 's pejsky',
		a11: 'teenagerů',
		a12: 'nezadaných',
		a13: 'businessové',
		a14: 'v přírodě',
		a15: 'se seniory',
		a16: 's romy',
		a17: 'na výletě',
		a18: 'u jídla',
		a19: 'u hobby',
		a20: 'u sportu',
	})
);

import IntersPrivsButtons from '../comp/IntersPrivsButtons';
import { useEffect, useState, useRef } from 'react';
import { useLoaderData, useNavigate, useOutletContext } from 'react-router-dom';
import useFadeIn from '../hooks/useFadeIn';
import CatFilter from '../comp/CatFilter';
import ImageCropper from '../comp/ImageCropper';
import axios from 'axios';
import Filter from '../comp/Filter';
import LocationPicker from '../comp/LocationPicker';
import DateTimePicker from '../comp/DateTimePicker';
import { findNearestCity, getDistance } from '../utils/locationUtils';
import EveMenuStrip from '../comp/menuStrips/EveMenuStrip';
import Invitations from '../comp/Invitations';
import { updateGalleryArrays } from '../comp/bottomMenu/Gallery/updateGalleryArrays';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import EventHeaderImage from '../comp/EventHeaderImage';

function Editor(props: any) {
	const { quickType = null, showMan, setShowMore, nowAt, brain } = ((useOutletContext() as any) || props) as any;
	const loaderEvent = useLoaderData() as any,
		navigate = useNavigate(),
		event = quickType === null ? loaderEvent : null,
		[data, setData] = useState<any>(
			brain.editorData || {
				...(event
					? {
							...event,
							starts: new Date(event.starts),
							ends: event.ends ? new Date(event.ends) : null,
							meetWhen: event.meetWhen ? new Date(event.meetWhen) : null,
							locaMode: event.location?.startsWith('+') ? 'radius' : event.location || event.place ? 'exact' : 'city',
							location: event.location?.startsWith('+') ? event.location.slice(1) : event.location,
							interPriv: event.interPriv || 'pub',
						}
					: { inter: 'sur', priv: 'pub', interPriv: 'pub', type: quickType, locaMode: 'exact' }),
			}
		);
	const [snap, setSnap] = useState<any>({ cats: data.type ? catsSrc.cz.filter(cat => catTypesStructure.get(cat).ids.includes(data.type)) : [catsSrc.cz[0]], types: [data.type] }),
		{ title, image, meetHow, meetWhen, detail, starts, ends, contacts, fee, links, takeWith, organizer } = data,
		extraFields = { detail, meet: meetHow || meetWhen, contacts, fee, links, takeWith, organizer },
		[selExtraFields, setSelExtraFields] = useState<any[]>(event ? Object.keys(extraFields).filter(key => extraFields[key]) : []),
		isQuick = quickType !== null,
		[fadedIn] = useFadeIn({ mode: isQuick ? 'quick' : 'editor' }) as any,
		[modes, setModes] = useState({ menu: false, invite: false }),
		[status, setStatus] = useState({ own: true }),
		[pendingInvitations, setPendingInvitations] = useState([]),
		[inviteStatus, setInviteStatus] = useState('idle'),
		extraFieldsTexts = useRef<any>({}),
		[inform, setInform] = useState([]),
		scrollTarget = useRef<any>(null),
		titleSectionRef = useRef<any>(null),
		placeSectionRef = useRef<any>(null);
	const shouldShowAttendanceButtons = isQuick || (!event && (data.type?.startsWith('a') || data.title));
	const [showCropper, setShowCropper] = useState(false);

	// INITIAL SCROLL--------------------------------------------------
	useEffect(() => {
		(async function initHandler() {
			if (!event && !(await forage({ mode: 'get', what: 'token' }))) return navigate('/entrance');
			if (!isQuick) window.scrollTo({ top: 0, behavior: 'smooth' });
			if (brain.editorData) delete brain.editorData;
			if (scrollTarget.current) setTimeout(() => window.scrollTo({ top: scrollTarget.current.getBoundingClientRect().top + window.scrollY - 100, behavior: 'smooth' }), isQuick ? 150 : 0);
		})();
	}, [window.location.pathname, scrollTarget.current]);

	useEffect(() => {
		if (isQuick && data.inter !== 'sur') setData(prev => ({ ...prev, inter: 'sur' }));
	}, [isQuick, data.inter]);

	console.log(data);

	// TODO before user confirms creatino of quick meeting, give him the option to choose from peopel or friendlyMeetings in the given radius
	// BUG check whether there is no date time shift after saving and drestoring dates from session storage
	// todo when editing event. need to show also the invited users for some  management. Or maybe just show the count and fetch data on some button click
	//BUG - this is very important, not a bug - we need to figure out how to synchronize event.priv and inter  priv for the events owner (the user). should the inter priv of the useer be always the same as the event, or should the owner have the option to change it? how? what are the implications? what to allow an what not? what should be sanitized ono backend and frontend?

	// MANAGER -------------------------------------------------------
	async function man(inp, val = null) {
		// VALUES SETTING -------------------------------------------
		let nextData = data;
		if (inp === 'inter') setData(prev => (nextData = { ...prev, inter: val }));
		else if (inp === 'interPriv') setData(prev => (nextData = { ...prev, interPriv: val }));
		else if (inp === 'image') setData(prev => (nextData = { ...prev, image: val }));
		else if (inp === 'priv')
			setData(prev => {
				const isNowPrivate = val !== 'pub' && val !== 'ind'; // 'ind' is usually not an event priv option in editor, but just in case
				// If switching to private, and attendance is set to 'links' or 'trusts', reset to 'pub' (Participants)
				const newInterPriv = isNowPrivate && ['lin', 'tru'].includes(prev.interPriv) ? 'pub' : prev.interPriv;
				return (nextData = { ...prev, priv: val, interPriv: newInterPriv });
			});
		else if (inp === 'locaMode')
			setData(prev => {
				nextData = { ...prev, locaMode: val };
				if (val === 'city') Object.assign(nextData, { location: '', lat: null, lng: null, place: null });
				else if (prev.locaMode === 'city') {
					Object.assign(nextData, { location: '', lat: null, lng: null, place: null });
					if (!prev.type?.startsWith('a')) Object.assign(nextData, { city: null, cityID: null });
				}
				return nextData;
			});
		else if (inp === 'location') {
			const { locaType, place, location, lat, lng, label, part, city, hashID, cityID } = val;
			setData(prev => {
				nextData = { ...prev, locaType, place, location, lat, lng, label, part, hashID };
				// Update city and cityID only if provided in val, otherwise keep existing
				if (city !== undefined) nextData.city = city;
				if (cityID !== undefined) nextData.cityID = cityID;

				if (locaType === 'city') nextData.locaMode = 'city';
				else if (prev.locaMode === 'city') nextData.locaMode = 'exact';
				return nextData;
			});
			// SCROLL TO TITLE SECTION AFTER LOCATION SELECTION (new events only) ---
			if (!data.id) setTimeout(() => titleSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
		} else if (inp === 'types') (setData(prev => (nextData = { ...prev, type: val })), setSnap(prev => ({ ...prev, types: [val] })));
		else if (inp === 'cats') (setSnap(prev => ({ ...prev, cats: [val] })), setData(prev => (nextData = { ...prev, type: null })));
		else if (inp === 'extraFields') setSelExtraFields(prev => (prev.includes(val) ? prev.filter(item => item !== val) : [...prev, val]));
		else if (inp === 'pendingInvite') {
			setPendingInvitations(prev => {
				if (prev.some(user => user.id === val.id)) return prev.filter(user => user.id !== val.id);
				return [...prev, val];
			});
			return;
		} else if (inp !== 'submit') {
			const hadNoStarts = !data.starts;
			setData(prev => (nextData = { ...prev, [inp]: val, ...(inp === 'cityID' && { city: null }), ...(inp === 'city' && { cityID: null }) }));
			// SCROLL TO PLACE SECTION AFTER FIRST STARTS SELECTION (new events only) ---
			if (inp === 'starts' && val && hadNoStarts && !data.id) setTimeout(() => placeSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
		}

		// REACTIVE VALIDATION ------------------------------------------
		// Steps: if we have active warnings, re-validate against the proposed 'nextData' so feedback is immediate as user types or clears fields.
		if (inform.length > 0) {
			const newWarn = [];
			const titleVal = inp === 'title' ? val : nextData.title;
			const typeVal = inp === 'types' ? val : nextData.type;
			const cityVal = inp === 'cityID' || inp === 'city' ? val : nextData.city || nextData.cityID;
			const startsVal = inp === 'starts' ? val : nextData.starts;

			if (!typeVal?.startsWith('a') && (titleVal || '').length < 2) newWarn.push((titleVal || '').length === 0 ? 'noTitle' : 'shortTitle');
			if (!cityVal) newWarn.push('noCity');
			if (nextData.locaMode !== 'city' && (!nextData.location || nextData.lat === undefined || nextData.lng === undefined)) newWarn.push('noLocation');
			if (!startsVal) newWarn.push('noStarts');
			if (!typeVal) newWarn.push('noType');
			setInform(newWarn);
		}

		// SUBMITING ------------------------------------------
		if (inp === 'submit') {
			const newWarn = [];
			if (!data.type?.startsWith('a') && (data.title || '').length < 2) newWarn.push((data.title || '').length === 0 ? 'noTitle' : 'shortTitle');
			if (!data.city && !data.cityID) newWarn.push('noCity');
			if (data.locaMode !== 'city' && (!data.location || data.lat === undefined || data.lng === undefined)) newWarn.push('noLocation');
			if (!data.starts) newWarn.push('noStarts');
			if (!data.type) newWarn.push('noType');

			// DURATION VALIDATION ---
			if (data.starts && data.ends) {
				const limit = data.type?.startsWith('a') ? MAX_EVENT_DURATIONS.friendly : MAX_EVENT_DURATIONS.regular;
				if (new Date(data.ends).getTime() > new Date(data.starts).getTime() + limit) {
					newWarn.push('longEvent');
				}
			}

			if (newWarn.length > 0) return setInform(newWarn);

			try {
				const axiData = delUndef({ ...data }, event ? true : false, true);
				// bug probably just send empty strings instead of nulls

				// CITY LOOKUP --------------------------------------
				if (data.locaMode === 'city') {
					axiData.cityID ??= brain.cities.find(city => city.hashID === data.city.hashID)?.cityID;
					['lat', 'lng', 'location', 'place', 'country', 'region', 'county'].forEach(key => delete axiData[key]);
					if (axiData.cityID) delete axiData.city;
				} else if (data.locaMode === 'radius') axiData.location = `+${axiData.location}`;

				if (data.locaMode !== 'city' && !axiData.cityID) {
					const possibleCities = brain.cities.filter(city => city.city === data.city && getDistance(city.lat, city.lng, axiData.lat, axiData.lng) < 10).sort((a, b) => a.distance - b.distance);
					if (possibleCities.length > 0) axiData.cityID = possibleCities[0].cityID;
					else {
						try {
							const nearestCityResult = await findNearestCity(data.city, { lat: data.lat, lng: data.lng });
							if (nearestCityResult) {
								const storedCityID = brain.cities.find(city => city.hashID === nearestCityResult.hashID)?.cityID;
								if (storedCityID) ((axiData.cityID = storedCityID), delete axiData.city);
								else axiData.city = nearestCityResult;
							}
						} catch (err) {
							console.error('Error finding city with Mapy.cz API:', err);
						}
					}
				}
				// REMOVE DESELECTED EXTRA FIELDS FROM REQUEST (editing only) --------------------
				if (event) {
					const extraFieldKeys = {
						detail: ['detail'],
						meet: ['meetHow', 'meetWhen'],
						contacts: ['contacts'],
						fee: ['fee'],
						links: ['links'],
						takeWith: ['takeWith'],
						organizer: ['organizer'],
					};
					Object.entries(extraFieldKeys).forEach(([key, dbKeys]) => {
						if (!selExtraFields.includes(key)) dbKeys.forEach(dbKey => (event[dbKey] ? (axiData[dbKey] = null) : delete axiData[dbKey])); // null to clear existing db value, delete to skip newly typed value
					});
				}
				// DELETE IRRELEVANT DATA --------------------------------------------------------
				if (event) for (const key in axiData) !['id', 'cityID'].includes(key) && (axiData[key] === event[key] || ['label', 'imgVers'].includes(key)) && delete axiData[key];
				else delete axiData.locaMode;

				let navigateTo = event?.id;
				if (Object.keys(axiData).length) {
					// PROCESS DATES -----------------------------------------------------
					(function processDates() {
						if ((typeof event?.starts === 'number' ? event.starts : Date.parse(event?.starts)) === starts.getTime()) delete axiData.starts;
						if ((typeof event?.ends === 'number' ? event.ends : Date.parse(event?.ends)) === ends?.getTime() || starts.getTime() === ends?.getTime()) delete axiData.ends;
						['starts', 'ends', 'meetWhen'].filter(key => axiData[key]).forEach(time => (axiData[time] = new Date(axiData[time]).getTime()));
					})();

					// AXIOS CALL -----------------------------------------------------
					const { createdID, cityData, imgVers } = (await axios.post('editor', axiData)).data;

					navigateTo ??= createdID;

					// SEND PENDING INVITATIONS AFTER EVENT CREATION
					if (!event?.id && createdID && pendingInvitations.length > 0) {
						try {
							setInviteStatus('sending');
							await axios.post('invites', {
								mode: 'inviteUsers',
								targetEvent: createdID,
								userIDs: pendingInvitations.map(user => user.id),
								userID: brain.user.id,
							});
							(setInviteStatus('success'), setPendingInvitations([]));
						} catch (inviteError) {
							notifyGlobalError(inviteError, 'Nepodařilo se odeslat pozvánky.');
							setInviteStatus('error');
						}
					}

					// FINALIZE DATA -------------------------------------------------------
					if (data.inter) (brain.user.unstableObj || brain.user).eveInters.push([createdID, data.inter, data.interPriv || 'pub']);
					if (cityData) (brain.cities.push(cityData), (axiData.cityID = cityData.cityID));
					if (imgVers) axiData.imgVers = imgVers;
					delete axiData.locaMode;

					// CRATE OR UPDATE EVENT OBJECT -------------------------------------------
					if (!event?.id) {
						if (data.type?.startsWith('a')) ((brain.user.eveUserIDs ??= {}), (brain.user.eveUserIDs[createdID] = [brain.user.id]));
						(function createEventObj() {
							brain.events[createdID] = {
								...axiData,
								id: createdID,
								own: true,
								state: 'basiDeta',
								inter: data.inter,
								cursors: 'gotAll',
								commsSyncedAt: Date.now(),
								city: cityData?.city || brain.cities.find(city => city.cityID === axiData.cityID)?.city,
								imgVers: axiData.imgVers || event?.imgVers || 0,
								...(axiData.hashID && { hashID: axiData.hashID }),
								score: 0,
								starts: Date.parse(data.starts),
								ends: data.ends ? Date.parse(data.ends) : null,
								meetWhen: data.meetWhen ? Date.parse(data.meetWhen) : null,
								owner: brain.user.id,
								surely: data.inter === 'sur' ? 1 : 0,
								maybe: data.inter === 'may' ? 1 : 0,
								rank: 0,
								interPriv: data.interPriv || 'pub',
								commsData: [],
								basiVers: 1,
								detaVers: 1,
								sync: Date.now(),
							};
						})();

						// Update friendlyMeetings stats and snaps history
						(function updateStatsAndHistory() {
							if (data.type?.startsWith('a')) {
								const stats = (brain.meetStats[axiData.cityID] ??= {});
								((stats[data.type] ??= { events: 0, people: 0 }), stats[data.type].events++, stats[data.type].people++);
							}
							// Determine which time frames the event belongs to
							const timeFrames = getTimeFrames();
							const belongsInto = Object.keys(timeFrames).filter(key => {
								const timeFrame = timeFrames[key];
								return starts >= timeFrame.start && starts <= timeFrame.end;
							});

							// Update user history and available types in time frames
							brain.user.history.forEach(snap => {
								if (snap.init || (snap.types.includes(data.type) && snap.cities.includes(axiData.cityID) && belongsInto.includes(snap.time))) {
									if (!snap.types.includes(data.type)) snap.types.push(data.type);
									const availObj = brain.citiesEveTypesInTimes[axiData.cityID];
									if (availObj) belongsInto.forEach(timeframe => !availObj[timeframe].includes(data.type) && availObj[timeframe].push(data.type));
								}
							});

							// UPDATE GALLERY ARRAYS --------------------------------------------
							updateGalleryArrays(brain, createdID, { addToOwn: true, addToInt: data.inter === 'int', addToSurMay: data.inter && data.inter !== 'int' });
						})();
					} else {
						// CLEAN axiData BEFORE ASSIGNING TO EVENT ------------
						const { city, locaMode, inter, ...cleanAxiData } = axiData; // remove non-serializable/transient props
						Object.assign(event, cleanAxiData);
					}
					const eveToStore = event?.id ? event : brain.events[createdID]; // pick correct event ref
					(forage({ mode: 'set', what: 'events', val: [eveToStore] }), forage({ mode: 'set', what: 'user', val: brain.user }));
				}

				navigate(`/event/${navigateTo}!${data.title ? encodeURIComponent(data.title.slice(0, 50)).replace(/%20/g, '_') : ''}`);
				if (isQuick) setTimeout(() => showMan('quick', false), 1000);
			} catch (err) {
				console.log('🚀 ~ file: Editor.jsx:74 ~ man ~ err:', err);
				const errorData = err.response?.data;
				const errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
				const displayText = (typeof errorData === 'object' && errorData?.message) || errorCode || 'Něco se pokazilo.';
				setInform([[displayText]]);
				notifyGlobalError(err, displayText);
			}
		}
	}
	function generateTitle(name, eventType) {
		const { beforeName = [], afterName = [], instrumental = [] } = eventTitles[eventType] || {};
		const getRandom = arr => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);
		const [randomBefore, randomAfter, randomInstrumental] = [beforeName, afterName, instrumental].map(getRandom);
		const safeName = name || 'Kamarád',
			titleOne = randomInstrumental ? `${randomInstrumental} s ${inflectName(safeName)}?` : null,
			titleTwo = randomBefore && randomAfter ? `${randomBefore} ${safeName}${randomAfter}` : null;
		return (Math.random() > 0.5 ? titleOne || titleTwo : titleTwo || titleOne) || `${safeName}?`;
	}

	return (
		<create-event ref={scrollTarget} onClick={() => setModes(prev => ({ ...prev, menu: false, invite: false }))} class={`w100 block  ${isQuick ? '' : 'mihvh101'} marAuto zinMax posRel  posRel textAli`}>
			{/* QUICK FRIENDLY HEADER --------------------------------------------------------- */}
			{isQuick && (
				<>
					<header-div class={`  w100 block   posAbs topCen zin1 flexCol aliCen  marAuto`}>
						<div className={`bgWhite topCen opacityXs shaCon mih1 posAbs w100 zin10`} />
						<div className={`bgWhite topCen opacityM shaCon mih0-5 posAbs w100 zin20`} />
						<images-wrapper class={'hvh20 bgTransXs block round'}>
							<img loading="lazy" className="w100 maskLow hvw30 mh33 zin2 cover" src={`/covers/friendlyMeetings/${quickType}.png`} alt="" />
							<img
								onClick={() => {
									showMan('quick', false);
									setShowMore(false);
								}}
								className="wvw50 posAbs topCen bgTrans   zinMax mw35  padHorL  pointer  boRadM  upEvenMore  hover padVerS    "
								src={`/icons/types/${quickType}.png`}
								alt=""
							/>
						</images-wrapper>
					</header-div>
					<empty-div class="block hvw20 mh18" />
				</>
			)}
			{/* CATEGORY + EVENT TYPE ---------------------- */}
			{!isQuick && !event && <CatFilter {...{ fadedIn, nowAt, snap, snapMan: man }} />}
			{!isQuick && !event && <Filter {...{ fadedIn, snapMan: man, nowAt, snap }} />}

			{/* EVENT IMAGE WITH TYPE ICON WHEN EDITING ---------------------- */}
			{data.id && !showCropper && (
				<div className="posRel w100">
					<EventHeaderImage event={{ ...event, type: event.type }} nowAt={'editor'} fadedIn={fadedIn} />
					{!data.type?.startsWith('a') && (
						<button
							onClick={e => {
								e.stopPropagation();
								setShowCropper(true);
							}}
							className="posAbs topRight marTopM marRigM zinMenu bDarkBlue tWhite padAllXs boRadS pointer xBold shaCon fs14">
							Upravit fotku
						</button>
					)}
				</div>
			)}
			{data.id && showCropper && (
				<div className={`fadingIn ${fadedIn.includes('Cropper') ? 'fadedIn' : ''} mw180 w100 marAuto marTopXxl`}>
					<div className="posRel marBotXxs block">
						<span className="boldM block textSha marBotXxxs opacityL fs16 tDarkBlue">Úprava fotky</span>
					</div>
					<div className="hr0-3 zin1 block borRed bInsetBlueTopXl borTop bgTrans w80 mw30 marAuto" />
					<ImageCropper data={data} superMan={man} nowAt={nowAt} image={image} />
					<button
						onClick={() => {
							man('image', null);
							setShowCropper(false);
						}}
						className="marTopM bDarkRed tWhite padAllXs boRadS pointer xBold shaCon block marAuto fs14">
						Zrušit úpravy
					</button>
				</div>
			)}

			{/* MENU BUTTON -------------------------------------------------*/}
			{event && (
				<editor-menu class={`zinMenu  marAuto marTopXs   block  ${modes.menu ? 'marBotXxxl' : ''}`}>
					<menu-comp onClick={e => (e.stopPropagation(), setModes(prev => ({ ...prev, menu: !prev.menu, invite: false })))} class={` flexCol w100`}>
						<menu-button class={`${modes.menu ? 'bDarkBlue tWhite' : ''}  shaBlue  bHover pointer flexCen aliCen xBold textSha justCen fs12 boRadXxs miw32 mw60 marAuto bgTrans padVerXxxs zinMaXl  posRel padHorS bold`}>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w100 marRigXs mw3">
								<path fillRule="evenodd" d="M4 5h16a1 1 0 010 2H4a1 1 0 010-2zm0 6h16a1 1 0 010 2H4a1 1 0 010-2zm0 6h16a1 1 0 010 2H4a1 1 0 010-2z" clipRule="evenodd" />
							</svg>
							Menu
						</menu-button>
						{modes.menu && <EveMenuStrip {...{ obj: event, brain, nowAt: 'editor', modes, setModes, status, setStatus, isCardOrStrip: false, userCardSetModes: () => {} }} />}
					</menu-comp>
				</editor-menu>
			)}

			{/* EVENT INFO ------------------*/}

			{data.type !== null && data.type !== undefined && (
				<event-info class={`fadingIn ${fadedIn.includes('EventInfo') || isQuick ? 'fadedIn' : ''}  w100 mw170  fPadHorS  textAli flexCol  marAuto labelM`}>
					{/* EVENT IMAGE / CROPPER ---------------*/}
					{!data.type?.startsWith('a') && !data.id && (
						<event-pic class={`fadingIn ${fadedIn.includes('Cropper') ? 'fadedIn' : ''} mw180 w100 marAuto  marTopXxl`}>
							<info-texts class="posRel marBotXxs    block">
								<span className="boldM block textSha marBotXxxs  opacityL fs16 tDarkBlue">Úvodní fotka (nepovinná)</span>
								<span className="fs7 inlineBlock marBotXxxs textSha opacityL">{`Události s fotkami mají zpravidla větší úspěšnost, nepodceňuj to :-)`}</span>
							</info-texts>
							<blue-divider class="hr0-3  zin1 block borRed bInsetBlueTopXl borTop bgTrans w80 mw30 marAuto" />
							<ImageCropper data={data} superMan={man} nowAt={nowAt} image={image} />
						</event-pic>
					)}
					{/* PLACE AND ADRESS---------------------------------------------- */}
					{isQuick &&
						(() => {
							const headerTitle = friendlyMeetingsHeaders.get(quickType);
							const details = { title: headerTitle, description: '' };
							return (
								<quickmeet-title class="zinMax padTopS  w100 mw80 boRadM   marAuto fitContent  ">
									<span className="fs30  lh1  tShaWhiteXl  block  ">
										Setkání
										<strong className={'marLefS tShaWhite   fs42 xBold'}>{`${details?.title}`}</strong>
									</span>
									<span className="fs12 inlineBlock ">
										Toto je <strong className="xBold">zkrácený formulář pro VEŘEJNÉ</strong> přátelské setkání.
										<button onClick={() => ((brain.editorData = data), navigate('editor'))} className="bInsetBlueTopXs posRel bBor2 fs14 inline xBold padHorXs marLefS  tGreen">
											Přejít na plný formulář.
										</button>
									</span>
								</quickmeet-title>
							);
						})()}

					{/* TITLE AND DESCRIPTION ---------------------------------------------- */}
					{(isQuick || data.type !== null || data.starts) && (
						<times-wrapper class={`block posRel noBackground ${!isQuick && data.starts ? (data.type?.startsWith('a') ? 'marTopXxl' : 'marTopXs') : isQuick ? 'marTopXl' : data.type?.startsWith('a') ? 'marTopXxl' : 'marTopM'}     w100`}>
							{!data.starts && !isQuick && (
								<info-texts class="posRel   marBotXs  block">
									<span className="boldM block textSha marBotXxxs  opacityL fs16 tDarkBlue">Čas konání tvé události</span>
									<span className="fs7 inlineBlock marBotXxxs textSha opacityL">{`začátek je povinný, konec je nepovinný. Vyber rok -> měsíc -> den -> hodinu -> minutu.`}</span>
								</info-texts>
							)}
							{!data.starts && !isQuick && <blue-divider class="hr0-3  zin1 block borRed bInsetBlueTopXl borTop bgTrans w80 marAuto" />}
							<DateTimePicker {...{ superMan: man, starts, ends, nowAt, meetWhen: data.meetWhen, type: data.type, isEditing: Boolean(event), ...(isQuick && { mode: 'week', noAutoHide: true }) }} />
						</times-wrapper>
					)}

					{/* LOCATION, CITY, PLACE ---------------------------------- */}
					{data.starts && (
						<place-wrapper ref={placeSectionRef} class={`flexCol   posRel   posRel  padTopXl    marAuto w100`}>
							{!isQuick && <blue-divider class={` hr0-3  block bInsetBlueTopXl borTop bgTrans posAbs topCen   w100 mw60    marAuto   `} />}

							<blue-divider class="hr8 posAbs topCen zin1 block  bInsetBlueTopXs2  bgTrans w80 mw140 marAuto" />
							<span className="xBold block textSha marBotXxs marTopXl opacityL fs16 tDarkBlue">Místo či oblast setkání</span>
							<span className="fs10 inlineBlock marBotXxs textSha opacityL">
								<strong>Doporučujeme:</strong> napiš stručně jak by sis setkání představoval, koho bys rád potkal apod. Je to nepovinné, ale zvýší to tvé události úspěšnost.
							</span>

							{/* LOCATION MODE ---------------------------------------------------------- */}
							{(isQuick || data.type?.startsWith('a')) && (
								<loca-mode class="flexCen w100  marAuto borderLight  borBot2    posRel  bPadVerXs  mw135  marTopXxs">
									{['radius', 'exact', 'city']
										.filter(option => !(option === 'city' && !!event && data.type?.startsWith('a') && (event.location || event.place)))
										.map(option => {
											return (
												<button key={option} className={`${data.locaMode === option ? 'bInsetBlueTopXs2 bBor2 shaBlueLight  posRel  fs13 boldM' : 'bold fs11'} w50 mw40 xBold bHover `} onClick={() => man('locaMode', option)}>
													{option === 'exact' ? 'Na přesném místě' : option === 'radius' ? 'v okolí místa' : 'kdekoliv ve městě'}
												</button>
											);
										})}
								</loca-mode>
							)}

							{/* LOCAITON PICKER -------------------------------------------------- */}
							{(!isQuick || data.locaMode) && <LocationPicker data={data} brain={brain} superMan={man} nowAt={'editor'} isEditing={!!event} isFriendly={data.type?.startsWith('a')} eventCity={event?.cityID} inform={inform} />}
							{/* SAME CITY WARNING FOR RADIUS/EXACT MODES ------------------------------------------- */}
							{!!event && data.type?.startsWith('a') && (event?.cityID || data.city) && (
								<span className="tRed fs10  wAuto inlineBlock   marAuto padBotXxs marTopXs  xBold block marBotXxxs textAli">
									{data.locaMode === 'city' ? 'U přátelských setkání nelze město měnit' : 'Vyhledávání je omezeno na město'} {data.locaMode === 'city' ? '' : brain.cities.find(c => c.cityID === event?.cityID || c.cityID === data.cityID || c.hashID === data.cityID)?.city || (typeof data.city === 'string' ? data.city : data.city?.city)}
								</span>
							)}
						</place-wrapper>
					)}
					{/* TITLE AND SHORT DESCRIPTION SECTION --- */}
					{(data.city || data.cityID) && data.starts && (
						<title-descrip ref={titleSectionRef} class="block w100     posRel">
							<info-texts class="posRel  marTopXxxl  block">
								<span className="xBold block textSha marBotXxs marTopM opacityL fs16 tDarkBlue">Titulek a úvodní slovo</span>
								<span className="fs10 inlineBlock marBotXxs textSha opacityL">
									<strong>Doporučujeme:</strong> napiš stručně jak by sis setkání představoval, koho bys rád potkal apod. Je to nepovinné, ale zvýší to tvé události úspěšnost.
								</span>
							</info-texts>

							{/* EVENT TITLE-------------------------------------------- */}
							{(data.starts || data.id) && (data.city || data.cityID) && <input autoFocus={!data.id} placeholder={`Titulek události ${data.type?.startsWith('a') ? '(nepovinný)' : '(povinný)'} ...`} className={`${inform.includes('noTitle') || inform.includes('shortTitle') ? 'borderRed' : ''} hr6 fs16 boldXs noBackground zinMax   w100`} type="text" value={title} name="title" onChange={e => man('title', e.target.value)} />}

							{/* SHORT DESCRIPTION-------------------------------------------- */}
							{(data.title || (data.type?.startsWith('a') && (data.city || data.cityID))) && (
								<short-description className="flexCol block   posRel">
									{/* AUTO FILL BUTTON ----------------------------------------------------- */}
									{snap.cats[0] === 'Přátelské' && (
										<button
											onClick={async () => {
												if (!brain.user.priv) await fetchOwnProfile(brain);
												man('title', generateTitle(brain.user.first, data.type));
												const exps = Array.isArray(brain.user.exps) ? brain.user.exps : [],
													favs = Array.isArray(brain.user.favs) ? brain.user.favs : []; // ------------------------ safe defaults for autofill
												let shortDescription = '';
												if (exps.length) shortDescription += `. Mé odborné znalosti: ${exps.join(', ')}. `;
												if (favs.length) shortDescription += `Rád si povídám o: ${favs.join(', ')}.`;
												if (brain.user.shortDesc) shortDescription += `${shortDescription ? ' +' : ''}Něco málo o mě: ${brain.user.shortDesc}`;
												man('shortDesc', shortDescription);
											}}
											className="w80  bDarkBlue tWhite   borRed  downLittle zinMax marAuto tBlue border mw30 fs8 bold padVerXxxs boRadXxxs">
											automaticky vyplnit
										</button>
									)}
									<textarea defaultValue={data['shortDesc']} placeholder="nepovinný stručný popis události ..." className="textArea   w100  bInsetBlueTopXs noBackground  borBotLight shaBlueLight  borTopLight padTopS fPadHorS padBotS textAli fs12" rows={3} onChange={e => man('shortDesc', e.target.value)} />
								</short-description>
							)}
						</title-descrip>
					)}

					{/* EXTRAS-ADD ---------------------------------------------- */}
					{!isQuick && ((data.type?.startsWith('a') && (data.city || data.cityID)) || data.title) && (
						<extrafields-add class="    posRel  block mw150 marAuto w100">
							<info-texts class="posRel padTopS marBotXs block">
								<span className="xBold block textSha   opacityL fs16 tDarkBlue marBotXxxs">Volitelné informace</span>
								{/* SHORT DESCRIPTION-------------------------------------------- */}
								<span className="fs10 inlineBlock marBotXxxs textSha opacityL">
									<strong>Doporučujeme:</strong> Vyber si, které další informace chceš do popisku své události přidat.
								</span>
							</info-texts>
							<extras-toggles class="w100   posRel  flexCen  marAuto flexCen wrap">
								{extraFieldsSrc.cz.map((item, i) => (
									<button key={item} name={extraFieldsSrc.en[i]} className={`${selExtraFields.includes(extraFieldsSrc.en[i]) ? 'xBold tSha10 bInsetBlueBotXl borTop2  boRadXxxs tWhite' : 'xBold'} grow  fs10  shaComment bHover padHorS shaBlue padVerXxs bgTrans  posRel  `} onClick={() => man('extraFields', extraFieldsSrc.en[i])}>
										{item}
									</button>
								))}
							</extras-toggles>
						</extrafields-add>
					)}

					{/* EXTRA FIELDS -----------------------------------------------------*/}
					{selExtraFields.length > 0 && (
						<extra-fields class=" bInsetBlueTopS posRel w100  mw150 textAli marAuto">
							<inner-wrapper class="w100 marTopXxxl flexCol aliCen   marAuto gapL">
								{/* MEET */}
								{selExtraFields.includes('meet') && (
									<city-meet class="flexCol w100  marAuto">
										<span className="fs16 tDarkBlue textSha inlineBlock  lh1 xBold">Kde a jak se potkáme?</span>
										<span className="  fs10  marAuto marBotXs">
											<strong className="  ">Doporučujeme:</strong> níže popsat místo a způsob setkání, tedy i jak se poznáte.
										</span>
										<DateTimePicker {...{ superMan: man, starts: meetWhen, prop: 'meetWhen', maxDate: data.starts, mode: 'week' }} />
										<textarea defaultValue={meetHow} placeholder="Sem napiš detaily ke srazu = popis místa setkání, oblečení, jak se poznáte/najdete, kontakt ..." className="textArea w100 shaSubtle shaSubtleLong borBotLight borderTop marTopS   boRadXs  padTopS textAli fs16" rows={4} onChange={e => (man('meetHow', e.target.value), (extraFieldsTexts.current.meetHow = e.target.value))} />
									</city-meet>
								)}
								{[
									{ field: 'detail', title: 'Detailní popis události', rows: 10 },
									{ field: 'takeWith', title: 'Vezměte si s sebou', rows: 3 },
									{ field: 'contacts', title: 'Důležité kontakty', rows: 3 },
									{ field: 'fee', title: 'Info ke vstupnému', rows: 3 },
									{ field: 'links', title: 'Odkazy a weby', rows: 3 },
									{ field: 'organizer', title: 'Pořadatel či značka', rows: 1 },
								].map(({ field, title, rows }) => {
									if (selExtraFields.includes(field)) {
										return (
											<div key={field} className="flexCol w100 marAuto">
												<span className="fs14 tDarkBlue inlineBlock lh1 xBold textSha marBotXxs">{title}</span>
												<textarea title={title} defaultValue={data[field]} className="textArea    w100 shaSubtle shaSubtleLong borBotLight borTopLight   boRadXs borderLight padAllS textAli fs16" rows={rows} onChange={e => man(field, e.target.value)} />
											</div>
										);
									}
								})}
							</inner-wrapper>
						</extra-fields>
					)}
				</event-info>
			)}
			{(data.city || data.cityID) && (
				<other-info class={`marTopXxxl  w100 mw170 marAuto block`}>
					{/* EVENT VISIBILITY (PRIV) --------------------------------------------- */}
					{(data.type?.startsWith('a') || data.title) && !event && !isQuick && data.type !== null && data.type !== undefined && (
						<privacy-settings class={'flexCol  w100 '}>
							<span className="boldM block textSha marBotXxs  opacityL fs16 tDarkBlue">Kdo událost uvidí?</span>
							<span className="fs10 inlineBlock marBotXxs textSha opacityL">
								<strong>Doporučujeme:</strong> napiš stručně jak by sis setkání představoval, koho bys rád potkal apod. Je to nepovinné, ale zvýší to tvé události úspěšnost.
							</span>

							<privacy-buttons class="flexCen w100  bPadXs mw150 marAuto marTopXs shaComment borderBot thickBors shaComment gapXxs posRel">
								{['public', 'links', 'trusts', 'invited'].map(button => (
									<button key={button} className={`${data.priv === button.slice(0, 3) ? `bInsetBlueBotXl tWhite boldS` : 'boldS'} noBackground grow fs12   zin1`} onClick={() => man('priv', button.slice(0, 3))}>
										{button === 'links' ? 'spojenci' : button === 'trusts' ? 'důvěrní' : button === 'public' ? 'všichni' : 'jen pozvaní'}
									</button>
								))}
							</privacy-buttons>

							{/* INTEREST AND ATTENDANCE PRIVACY BUTTONS ------------------------------------------------- */}
							{shouldShowAttendanceButtons && (
								<div className="marTopXxl mw150 marAuto w100">
									<title-texts className="marBotXs block borBotLight">
										<span className="boldM block textSha marBotXxs opacityL fs16 tDarkBlue">{`${data.type?.startsWith('a') ? 'Jak s účastí počítáš?' : 'Dorazíš? A kdo Tvou účast uvidí?'}`}</span>
										<span className="fs10 inlineBlock marBotXxs textSha opacityL">
											<strong>Důležité:</strong> {`${data.type?.startsWith('a') ? 'Na přátelských setkáních tvou účast uvidí všichni z cílové skupiny uživatelů' : ''}`}
										</span>
									</title-texts>

									<IntersPrivsButtons
										obj={{ priv: data.priv, type: data.type }}
										status={{ inter: data.inter, interPriv: data.interPriv }}
										brain={brain}
										nowAt="editor"
										modes={{}}
										onUpdate={({ inter, priv }) => {
											if (inter !== undefined) man('inter', inter);
											if (priv !== undefined) man('interPriv', priv);
										}}
									/>
								</div>
							)}
						</privacy-settings>
					)}

					{/* PENDING INVITATIONS FOR NEW EVENTS */}
					{!event && (data.city || data.cityID) && data.type !== null && data.type !== undefined && (data.type?.startsWith('a') || data.title) && (
						<pending-invitations class=" block marBotM">
							<span className={`boldM block textSha marBotXxs ${!isQuick ? 'marTopXl' : ''} opacityL fs16 tDarkBlue`}>Rozeslání pozvánek</span>
							<span className="fs10 inlineBlock  textSha opacityL">
								<strong>Doporučujeme:</strong> Vyhledej spojence a nebo důvěrníky a pozvi je na svoji událost.
							</span>
							<Invitations
								{...({
									brain,
									obj: null,
									nowAt: 'editor',
									mode: 'eventToUsers',
									isPreparation: true,
									selectedItems: pendingInvitations,
									superMan: man,
									pendingMode: true,
									onSuccess: () => {},
								} as any)}
							/>

							{/* INVITE STATUS ------------------------------------------------- */}
							{['sending', 'success', 'error'].map(status => {
								const statusTexts = { sending: 'Odesílám pozvánky...', success: 'Pozvánky úspěšně odeslány!', error: 'Chyba při odesílání pozvánek' };
								if (inviteStatus === status) {
									return (
										<invite-status key={status} class="marTopXs">
											<span className="fs14 tBlue xBold">{statusTexts[status]}</span>
										</invite-status>
									);
								}
							})}
						</pending-invitations>
					)}

					{/* EXISTING EVENT INVITATIONS */}
					{event && <Invitations {...({ brain, obj: event, onSuccess: () => setModes(prev => ({ ...prev, invite: false, menu: false })), downMargin: true, setModes } as any)} />}

					{isQuick && (
						<full-redirect class="fs12 w100 textAli marAuto flexCol marBotS  ">
							<span className="inlineBlock fs12 marBotXxxs">
								Chceš nastavit <strong className="xBold w100">soukromí a pokročilé volby?</strong>
							</span>
							<button onClick={() => ((brain.editorData = data), navigate('editor'))} className="bInsetBlueTopXs posRel bBor2 fs10 inline xBold padHorXs mw30 marAuto tGreen">
								Přejít na plný formulář.
							</button>
						</full-redirect>
					)}

					{/* WARNING MESSAGES ------------------------------------------------*/}
					{inform.length > 0 && (
						<inform-messages class="marBotXs block marTopS ">
							{(() => {
								const informTexts = {
									noType: 'Není zvolen typ události',
									noTitle: 'název události je povinný',
									shortTitle: 'Název musí mít alespoň 2 znaky',
									noCity: 'chybí místo konání',
									noStarts: 'vyplň začátek události',
									longEvent: `Událost je příliš dlouhá (max ${data.type?.startsWith('a') ? '3 dny' : '1 měsíc'})`,
									error: 'Zápis selhal! Za 20 vteřin zopakuj.',
								};
								const actualWarnings = Object.keys(informTexts).filter(warn => inform.includes(warn));
								return actualWarnings.map((inform, index) => (
									<span key={inform} className="tRed marRigXs xBold fsC  lh1 inlineBlock aliCen">
										{`${index > 0 ? ' + ' : ''}${informTexts[inform]}`}
									</span>
								));
							})()}
						</inform-messages>
					)}

					{/* SUBMIT BUTTON ------------------------------ */}
					{(data.type?.startsWith('a') || data.title || (isQuick && (data.city || data.cityID))) && data.type !== null && data.type !== undefined && (
						<button onClick={() => man('submit')} className={`fadingIn ${(isQuick && (data.city || data.cityID)) || fadedIn.includes('EventInfo') ? 'fadedIn' : ''} ${inform.length > 0 ? 'bRed' : 'bDarkGreen'} tWhite bHover xBold fs20 w95 mw80  posRel  marBotXxs marAuto  ${!shouldShowAttendanceButtons ? 'marTopXl' : ''} padVerS boRadS`}>
							{inform.length > 0 ? 'Vyplň povinné údaje!' : !event ? (isQuick ? 'Zveřejnit přátelské setkání' : 'Vytvořit událost!') : 'Uložit změny události'}
						</button>
					)}
				</other-info>
			)}
			{!isQuick && <empty-div class="block  mih14" />}
		</create-event>
	);
}

export default Editor;
