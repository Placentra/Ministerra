import { useEffect } from 'react'; // Add this import if not present
import { PRIVACIES, INTERESTS, PRIVACIES_SET } from '../../../shared/constants';
import { fetchOwnProfile, forage } from '../../helpers';
import axios from 'axios';
import useErrorsMan from '../hooks/useErrorsMan';
import { updateGalleryArrays } from './bottomMenu/Gallery/updateGalleryArrays';

const attenVisibSrc = { [PRIVACIES.public]: 'všichni', [PRIVACIES.links]: 'spojenci', [PRIVACIES.trusts]: 'důvěrní', [PRIVACIES.owner]: 'autor' };

function IntersPrivsButtons(props) {
	// TODO if user removes interest (there needs to be option to "unfollow", not "change interest") from past event remove the event from the user's past events

	const { fadedIn = ['BsEvent'], status, brain, nowAt, obj, modes, setStatus, setModes, isPast, onPrivSelected, resetTimer, onUpdate } = props;
	const isFriendly = obj.type && obj.type.startsWith('a');
	const askPriv = brain.user.askPriv;
	const errorMan = useErrorsMan();

	// AUTO SELECT WATCH INTEREST IF REQUESTED ------------------------------
	useEffect(() => {
		if (modes.autoSelectInter && !status.inter) {
			setEventInter({ inter: 'int', priv: isFriendly ? 'pub' : status.interPriv || brain.user.defPriv || 'pub' });
			setModes(prev => {
				const { autoSelectInter, ...rest } = prev;
				return rest;
			});
		}
	}, [modes.autoSelectInter]);

	// DEBOUNCE INTERESTS OR PRIVACIES ---------------------------------------------------
	const debounceInterOrPriv = async ({ interFlag = '', priv }) => {
		try {
			const user = brain.user.unstableObj || brain.user;
			const profilePromise = obj.type?.startsWith('a') && interFlag && !brain.user.priv && [INTERESTS.surely, INTERESTS.maybe].some(str => interFlag.startsWith(str)) ? fetchOwnProfile(brain) : Promise.resolve({});
			const finalPriv = interFlag?.startsWith('min') ? null : PRIVACIES_SET.has(priv) ? priv : PRIVACIES.public;
			await Promise.all([axios.post('interests', { eventID: obj.id, inter: interFlag || `${status.inter}Priv`, priv: finalPriv }), profilePromise]);
			Object.assign(obj, {
				inter: interFlag ? [INTERESTS.interested, INTERESTS.maybe, INTERESTS.surely].find(str => interFlag.startsWith(str)) || null : status.inter,
				interPriv: finalPriv ?? obj.interPriv,
			});

			// update user's interactions data and gallery
			const eveInters = user.eveInters || [];
			const interArr = eveInters.find(e => String(e[0]) === String(obj.id));
			if (interArr) {
				if (!obj.inter) user.eveInters = eveInters.filter(e => String(e[0]) !== String(obj.id));
				else ((interArr[1] = obj.inter), (interArr[2] = finalPriv || 'pub'));
			} else if (obj.inter) {
				if (!user.eveInters) user.eveInters = [];
				user.eveInters.push([obj.id, obj.inter, finalPriv || 'pub']);
			}

			if (interFlag && interFlag.startsWith(INTERESTS.interested)) updateGalleryArrays(brain, obj.id, { addToInt: true, removeFromSurMay: interFlag.length > 3 });
			else if (interFlag && [INTERESTS.surely, INTERESTS.maybe].some(str => interFlag.startsWith(str))) updateGalleryArrays(brain, obj.id, { addToSurMay: true, removeFromInt: interFlag.slice(3) === INTERESTS.interested });
			(setModes(prev => ({ ...prev, privs: false, inter: false })), forage({ mode: 'set', what: 'user', val: brain.user }), delete brain.interInProg[obj.id]);
		} catch (err) {
			setStatus(prev => ({ ...prev, inter: obj.inter, interPriv: obj.interPriv, surely: obj.surely, maybe: obj.maybe }));
			(delete brain.interInProg[obj.id], delete brain.privInProg[obj.id], errorMan(err), setModes(prev => ({ ...prev, privs: false })));
			console.error('Error in debounceInterOrPriv:', err);
			// Do not rethrow from a UI path; this can create unhandled promise rejections
			// and crash the React tree. Error reporting is handled via errorMan().
			return;
		}
	};

	// SET EVENT INTERREST ----------------------------------------------------------
	const setEventInter = async ({ inter, priv }) => {
		// EDITOR MODE BYPASS
		if (onUpdate) {
			let newInter = status.inter === inter ? false : inter;
			if (isFriendly && !newInter) newInter = inter; // Prevent deselecting for friendly events
			onUpdate({ inter: newInter, priv: isFriendly ? 'pub' : priv || status.interPriv || 'pub' });
			if (setModes) setModes(prev => ({ ...prev, privs: false, inter: false }));
			return;
		}

		if (resetTimer) resetTimer();
		if (nowAt === 'event' && !brain.user.first) await fetchOwnProfile(brain);
		const curInterFlagExtension = obj.inter ? obj.inter.charAt(0).toUpperCase() + obj.inter.slice(1) : '';
		if (!obj.inter && status.inter === inter) {
			const initialState = ['inter', 'surely', 'maybe', 'interPriv'].reduce((acc, key) => ({ ...acc, [key]: obj[key] }), {});
			(clearTimeout(brain.interInProg[obj.id]?.timeout), delete brain.interInProg[obj.id]);
			(setStatus(prev => ({ ...prev, ...initialState })), setModes(prev => ({ ...prev, privs: false, inter: false })));
			return;
		}

		const getFlagAndStatusProps = inter => {
			const flag = obj.inter ? (obj.inter === inter ? `min${curInterFlagExtension}` : `${inter}${curInterFlagExtension}`) : inter;
			return [
				flag,
				{
					inter: status.inter === inter ? false : inter,
					surely: flag.slice(3) === 'Sur' ? obj.surely - 1 : flag.startsWith('sur') ? obj.surely + 1 : obj.surely,
					maybe: flag.slice(3) === 'May' ? obj.maybe - 1 : flag.startsWith('may') ? obj.maybe + 1 : obj.maybe,
					interPriv: priv || 'pub',
				},
			];
		};
		try {
			let [interFlag, newStatusProps] = getFlagAndStatusProps(inter);
			(clearTimeout(brain.privInProg[obj.id]?.timeout), delete brain.privInProg[obj.id]);
			if (brain.interInProg[obj.id]) {
				const { timeout, interFlag: oldInterFlag } = brain.interInProg[obj.id];
				clearTimeout(timeout);
				if (oldInterFlag === interFlag) {
					if (obj.inter && obj.inter !== inter) {
						// SWITCH TO REMOVAL OF ORIGINAL INTERESTS ----------------------
						const curInterFlagExtension = obj.inter.charAt(0).toUpperCase() + obj.inter.slice(1);
						interFlag = `min${curInterFlagExtension}`;
						newStatusProps = {
							inter: false,
							surely: obj.inter === 'surely' ? obj.surely - 1 : obj.surely,
							maybe: obj.inter === 'maybe' ? obj.maybe - 1 : obj.maybe,
							interPriv: status.interPriv,
						};
					} else {
						// CANCEL PENDING OP, RESTORE TO OBJ STATE -----------------
						const initialState = ['inter', 'surely', 'maybe', 'interPriv'].reduce((acc, key) => ({ ...acc, [key]: obj[key] }), {});
						return (delete brain.interInProg[obj.id], setStatus(prev => ({ ...prev, ...initialState })), setModes(prev => ({ ...prev, privs: false, inter: false })));
					}
				}
			}
			// CAPTURE FINAL STATE AT CREATION ---
			// Steps: store interFlag/priv in closure so timeout fires with intended state even if brain.interInProg is mutated before timeout triggers.
			const capturedInterFlag = interFlag;
			const capturedPriv = priv;
			brain.interInProg[obj.id] = {
				priv,
				interFlag,
				timeout: setTimeout(() => {
					// READ LATEST PRIV (USER MAY HAVE CHANGED IT VIA setInterPriv) ---
					// Steps: priv can be updated via setInterPriv after interFlag is set, so read the latest priv from brain.interInProg if it exists.
					const cur = brain.interInProg[obj.id] || {};
					const finalInterFlag = cur.interFlag ?? capturedInterFlag;
					const finalPriv = cur.priv ?? capturedPriv;
					const PRIVACIES_SET = new Set(['pub', 'lin', 'own', 'tru']);
					const latestPriv = finalInterFlag?.startsWith('min') ? null : PRIVACIES_SET.has(finalPriv) ? finalPriv : 'pub';
					debounceInterOrPriv({ interFlag: finalInterFlag, priv: latestPriv });
				}, 800),
			};
			if (askPriv && !modes.privs) setModes(prev => ({ ...prev, privs: true }));
			setStatus(prev => ({ ...prev, ...newStatusProps }));
		} catch (err) {
			console.error('Error in setEventInter:', err);
		}
	};
	// SET EVENT PRIVACIES -------------------------------------------------------------
	const setInterPriv = ({ priv }) => {
		// EDITOR MODE BYPASS
		if (onUpdate) {
			onUpdate({ priv });
			// Clear modes if needed, though Editor might not use them the same way
			if (setModes) setModes(prev => ({ ...prev, privs: false, inter: false }));
			return;
		}

		if (resetTimer) resetTimer();
		// Clear the priv visibility timeout since user is manually selecting a priv
		if (brain.privsTimeout?.[obj.id]) {
			clearTimeout(brain.privsTimeout[obj.id]);
			delete brain.privsTimeout[obj.id];
		}

		if (brain.interInProg[obj.id]) {
			clearTimeout(brain.interInProg[obj.id].timeout);
			brain.interInProg[obj.id].priv = priv;
			brain.interInProg[obj.id].timeout = setTimeout(() => {
				const cur = brain.interInProg[obj.id] || {};
				const PRIVACIES_SET = new Set(['pub', 'lin', 'own', 'tru']);
				const latestPriv = cur.interFlag?.startsWith('min') ? null : PRIVACIES_SET.has(cur.priv) ? cur.priv : 'pub';
				debounceInterOrPriv({ interFlag: cur.interFlag, priv: latestPriv });
			}, 800);
		} else {
			clearTimeout(brain.privInProg[obj.id]?.timeout);
			brain.privInProg[obj.id] = { priv, timeout: setTimeout(() => debounceInterOrPriv({ priv }), 800) };
		}
		setStatus(prev => ({ ...prev, interPriv: priv }));
		onPrivSelected?.(); // NOTIFY PARENT PRIV SELECTED ---------------------------
	};

	const disableInters = (status.isMeeting && status.own) || isPast;
	const intersSrc = isFriendly
		? [
				{ key: 'surely', short: 'sur', label: 'určitě přijdu' },
				{ key: 'maybe', short: 'may', label: 'možná přijdu' },
			]
		: [
				{ key: 'error', short: 'no', label: 'nepřijdu' },
				{ key: 'surely', short: 'sur', label: 'určitě přijdu' },
				{ key: 'maybe', short: 'may', label: 'možná přijdu' },
			];

	// INTERESTS BUTTONS ---
	const inEditor = !!onUpdate;
	const intersButtons = (
		<inters-bs class={`fadingIn ${fadedIn.includes('BsEvent') ? 'fadedIn' : ''}  flexCen   aliStretch zinMax gapXxxs w100 	 overHidden`}>
			{intersSrc.map((btn, i) => {
				const isNo = btn.short === 'no';
				const isSelected = isNo ? !status.inter : status.inter === btn.short;
				const widthClass = inEditor ? 'mw90' : isFriendly && !status.inter ? 'imw8' : isSelected ? 'imw10' : 'imw5';
				const selectedClass = isSelected ? ' imw12 ' : ' imw6';
				const fontClass = inEditor ? 'fs9' : 'fs5';

				return (
					<button
						key={btn.key}
						onClick={() => {
							if (disableInters) return;
							if (isNo) {
								if (status.inter) setEventInter({ inter: status.inter, priv: 'pub' });
							} else {
								setEventInter({ inter: btn.short, priv: isFriendly ? 'pub' : status.interPriv || brain.user.defPriv || 'pub' });
							}
						}}
						className={`${widthClass} ${selectedClass} noBackground ${disableInters && !isSelected ? 'tDis opaque' : ''}  ${nowAt === 'event' ? `padTopXxs   padBotXxs` : nowAt === 'editor' ? 'padBotXxs bBor' : `padBotXxs  padTopXxs `} textSha posRel   zin10 grow bHover flexCol aliCen`}>
						<img className=" aspect169 posRel downTiny maskLowXs  w80" src={`/icons/${btn.key === 'interested' ? 'eye' : btn.key}.png`} alt="" />
						<span className={`textSha marTopXxxxs ${isSelected ? 'bold' : ''} ${fontClass}`}>{btn.label}</span>
					</button>
				);
			})}
		</inters-bs>
	);

	// PRIVS BUTTONS ---
	// Logic: For private events (not 'pub'/'ind'), we treat 'pub' attendance as "Visible to Participants"
	// and hide the specific 'links' option to avoid confusion.
	const isEventPrivate = obj.priv && !['pub', 'ind'].includes(obj.priv);
	const showPrivs = !isFriendly && !!status.inter;

	const privsButtons = showPrivs && (
		<privs-bs class="flexCen w100 marAuto zinMenu posRel mw150   ">
			{Object.entries(attenVisibSrc).map(([option, title]) => {
				if (isEventPrivate) {
					// Hide Links and Trusts for private events as they restrict visibility to the user's graph,
					// creating "holes" where other attendees cannot see them.
					// Private events use "Participants" (pub) for shared visibility or "Owner" (own) for stealth.
					if (option === PRIVACIES.links || option === PRIVACIES.trusts) return null;

					if (option === PRIVACIES.public) {
						// Render Public as "Participants"
						return (
							<button key={option} className={`bHover ${inEditor ? 'mw70 w25' : 'w25'} padVerXs bBor marAuto maskTopXs noBackground posRel zinMenu ${status.interPriv === option ? ' xBold tDarkBlue  fs14' : 'bold   fs8 '}`} onClick={() => (option === status.interPriv ? setModes(prev => ({ ...prev, privs: false, inter: false })) : setInterPriv({ priv: option }))}>
								<button-texture style={{ filter: 'brightness(1.5)' }} class="noPoint padAllXxxs posAbs botCen zin1 w100 h100 " />
								účastníci
							</button>
						);
					}
				}

				return (
					<button key={option} className={`bHover ${inEditor ? 'mw70 w25' : 'w25'} padVerXs  marAuto bInsetBlueTopXs bBor2   posRel zinMenu ${status.interPriv === option ? ' xBold tDarkBlue  fs18' : 'bold   fs12 '}`} onClick={() => (option === status.interPriv ? setModes(prev => ({ ...prev, privs: false, inter: false })) : setInterPriv({ priv: option }))}>
						<button-texture style={{ filter: 'brightness(1.5)' }} class="noPoint padAllXxxs posAbs botCen zin1 w100 h100 " />
						{title}
					</button>
				);
			})}
		</privs-bs>
	);

	return (
		<inters-privs class="posRel w100 overHidden block">
			{intersButtons}
			{inEditor && <div className="marTopXs"></div>}
			{privsButtons}
		</inters-privs>
	);
}

export default IntersPrivsButtons;
