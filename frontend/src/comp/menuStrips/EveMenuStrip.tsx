import { useState, useContext } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { humanizeDateTime, forage } from '../../../helpers';
import SimpleProtocol from '../SimpleProtocol';
import MenuButtons from './stripButtonsJSX';
import IntersPrivsButtons from '../IntersPrivsButtons';
import Invitations from '../Invitations';
import { updateGalleryArrays } from '../bottomMenu/Gallery/updateGalleryArrays';
import { previewEveCard } from './helpers';
import { notifyGlobalError } from '../../hooks/useErrorsMan';
import EventFeedbackProtocol from '../EventFeedbackProtocol';
import { storeMenuViewState } from '../LogoAndMenu';
import { globalContext } from '../../contexts/globalContext';

// HELPERS ---------------------------------------------------------------------
const getErrorMsg = (error, fallback) => error?.response?.data?.message || error?.response?.data || fallback || 'error';

/** ----------------------------------------------------------------------------
 * EVENT MENU STRIP COMPONENT
 * Manages action menu for events (edit, delete, share, feedback, etc.)
 * Handles complex actions like cancelling, deleting, and inviting users.
 * -------------------------------------------------------------------------- */
function EveMenuStrip({
	obj: eventObj = {}, // Renamed obj to eventObj
	modes = {},
	isCardOrStrip,
	galleryMode = '',
	isSearch,
	brain = {},
	status = {},
	setStatus,
	setModes,
	nowAt,
	userCardSetModes,
	setGalleryContent,
}: any) {
	const navigate = useNavigate();
	const { id: eventID } = eventObj;
	const { menuView } = useContext(globalContext);

	// STATE MANAGEMENT ----------------------------------------------------------
	const [selectedButton, setSelectedButton] = useState(null);
	const [{ own = eventObj.owner === brain.user.id, copied }, { protocol }] = [status, modes];
	const [confirmStage, setConfirmStage] = useState(1); // 1: Confirm, 2: Really sure?, 3: Done/Processing
	const [error, setError] = useState('');
	const [undeletable, setUndeletable] = useState(false);

	// DERIVED STATE -------------------------------------------------------------
	const isInactive = status.deleted || status.canceled || eventObj.canceled;
	const directionKey = galleryMode === 'invitesIn' ? 'in' : 'out';

	// Invitation list state (synced with brain/props)
	const [inviteUsers, setInviteUsers] = useState(brain.user?.[galleryMode]?.[eventID] || (Array.isArray(eventObj.invites) ? eventObj.invites : eventObj.invites?.[directionKey]) || []);

	const invitesTotal = eventObj[galleryMode === 'invitesIn' ? 'invitesInTotal' : 'invitesOutTotal'] || 0;
	const feedbackBaseTime = eventObj.ends || eventObj.starts;
	// Feedback allowed for 30 days after start/end
	const allowFeedback = Boolean(brain.user?.id && feedbackBaseTime && !eventObj.type.startsWith('a') && Date.now() >= feedbackBaseTime && Date.now() <= feedbackBaseTime + 2592000000);

	// UTILITY FUNCTIONS ---------------------------------------------------------
	const toggleMode = (mode, value = undefined) =>
		setModes(prev => ({
			...Object.keys(prev).reduce((acc, key) => ({ ...acc, [key]: false }), {}),
			menu: true,
			[mode]: value !== undefined ? value : !prev[mode],
		}));

	const handleRequestError = (requestError, fallbackMsg) => {
		const msg = getErrorMsg(requestError, fallbackMsg);
		setError(msg);
		notifyGlobalError(requestError, fallbackMsg || msg);
	};

	// ACTION: MODIFY EVENT (DELETE / CANCEL) ------------------------------------
	const modifyEvent = async (mode, msg) => {
		try {
			await axios.post('editor', { id: eventID, mode });

			// Optimistic Local Updates
			if (mode === 'delete') {
				Object.assign(brain.events, { [eventID]: { id: eventID, state: 'del', deleted: true } });
			} else {
				eventObj.canceled = true;
				if (brain.events[eventID]) {
					brain.events[eventID].canceled = true;
					await forage({ mode: 'set', what: 'events', id: eventID, val: brain.events[eventID] });
				}
			}

			// Cleanup User Interactions
			if (brain.users) Object.values(brain.users).forEach((user: any) => user.eveInters?.[eventID] && delete user.eveInters[eventID]);
			if (brain.user.eveInters?.[eventID]) delete brain.user.eveInters[eventID];

			// Update UI
			setConfirmStage(3);
			setStatus(prev => ({ ...prev, [mode === 'delete' ? 'deleted' : 'canceled']: true, inter: null, interPriv: null }));
			setModes(prev => ({ ...prev, [mode]: false, menu: false }));
			if (nowAt === 'editor') navigate(-1);

			// Final Cleanup & Reset
			setTimeout(async () => {
				if (mode === 'delete') await forage({ mode: 'set', what: 'events', id: eventID, val: brain.events[eventID] });
				setConfirmStage(0);
			}, 1500);
		} catch (err) {
			handleRequestError(err, msg);
		}
	};

	const deleteOwnEvent = () => modifyEvent('delete', 'Nepodařilo se smazat událost.');
	const cancelOwnEvent = () => modifyEvent('cancel', 'Nepodařilo se zrušit událost.');

	// ACTION: MANAGE INVITES ----------------------------------------------------
	const handleInviteAction = async (mode, targetUser = null) => {
		try {
			await axios.post('invites', { targetEvent: eventID, mode, ...(targetUser ? { targetUser } : {}) });

			const updateLocalState = targetMode => {
				if (!targetUser) {
					// Clear all invites locally
					eventObj.invites = [];
					if (brain.user[galleryMode]) delete brain.user[galleryMode][eventID];
				} else {
					// Remove specific user locally
					const nextUsers = (brain.user[galleryMode]?.[eventID] || []).filter(user => user.id !== targetUser);
					brain.user[galleryMode] ??= {};
					brain.user[galleryMode][eventID] = eventObj.invites = nextUsers;
					setInviteUsers(eventObj.invites);
				}

				// If list is empty, update gallery views
				if (eventObj.invites.length === 0) {
					updateGalleryArrays(brain, eventObj.id, { [`removeFromInvites${targetMode}`]: true });
					setGalleryContent?.(prev => prev.filter(item => item.id !== eventID));
					if (brain.user[galleryMode]) delete brain.user[galleryMode][eventID];
				}
			};

			const list = Array.isArray(eventObj.invites) ? eventObj.invites : eventObj.invites?.[directionKey] || [];
			const userFound = list.find(user => user.id === targetUser);

			if (['accept', 'refuse'].includes(mode) && userFound) {
				userFound.flag = mode === 'accept' ? 'acc' : 'ref';
				setStatus(prev => ({
					...prev,
					invited: (Array.isArray(eventObj.invites) ? eventObj.invites : [...(eventObj.invites?.in || []), ...(eventObj.invites?.out || [])]).some(user => user.flag === 'ok'),
				}));
				if (mode === 'accept' && !status.inter) toggleMode('inter', true);
			} else if (['cancel', 'delete', 'cancelAll', 'deleteAll'].includes(mode)) {
				updateLocalState(['cancel', 'cancelAll'].includes(mode) ? 'Out' : 'In');
			}
			return true;
		} catch (err) {
			handleRequestError(err, 'Akci s pozvánkou se nepodařilo dokončit.');
			return false;
		}
	};

	const handleBulkInvites = async () => {
		const success = await handleInviteAction(galleryMode === 'invitesOut' ? 'cancelAll' : 'deleteAll');
		if (success) {
			eventObj.invites = [];
			eventObj.invited = false;
			if (brain.user[galleryMode]) delete brain.user[galleryMode][eventID];
			setInviteUsers([]);
			updateGalleryArrays(brain, eventObj.id, { [galleryMode === 'invitesOut' ? 'removeFromInvitesOut' : 'removeFromInvitesIn']: true });
			setGalleryContent?.(prev => prev.filter(item => item.id !== eventID));
			setModes(prev => ({ ...prev, invitees: false, invitors: false, menu: false }));
		}
	};

	const fetchMoreUsers = async () => {
		try {
			const moreUsers = (await axios.post('invites', { targetEvent: eventID, mode: 'list', direction: directionKey, offset: inviteUsers.length })).data;
			if (moreUsers.length) {
				brain.user[galleryMode] ??= {};
				const merged = [...inviteUsers, ...moreUsers];
				// Deduplicate by ID
				const deduped = Array.from(new Map(merged.map(user => [user.id, user])).values());
				brain.user[galleryMode][eventID] = eventObj.invites = deduped;
				setInviteUsers(eventObj.invites);
			}
		} catch (err) {
			handleRequestError(err, 'Nepodařilo se načíst další uživatele.');
		}
	};

	// ACTION: OTHER UTILS -------------------------------------------------------
	const copyTextsAndLink = () => {
		const lines = [
			`Událost: ${eventObj.title}`,
			eventObj.surely || (eventObj.maybe && `Hostů: ${eventObj.surely} určitě, ${eventObj.maybe} možná`),
			eventObj.shortDesc && `Popis: ${eventObj.shortDesc}`,
			eventObj.detail && `Detail: ${eventObj.detail}`,
			eventObj.link && `Odkaz: ${eventObj.link}`,
			`Kdy: ${humanizeDateTime(eventObj.starts)}`,
			`Kde: ${eventObj.place ? `${eventObj.place} - ` : ''}${eventObj.location} - ${eventObj.city}`,
			eventObj.meetHow && `Sraz: ${eventObj.meetHow}${eventObj.meetWhen ? ` - ${humanizeDateTime(eventObj.meetWhen)}` : ''}`,
		]
			.filter(Boolean)
			.join('\n');
		navigator.clipboard.writeText(lines).catch(err => console.error('Could not copy text:', err));
		setStatus(prev => ({ ...prev, copied: status.copied === true ? 'info' : true }));
	};

	const deletePastEvent = async () => {
		try {
			await axios.post('gallery', { userID: brain.user.id, eventID: eventObj.id, mode: 'deletePast' });
			if (brain.user.pastEve[eventObj.id]) {
				delete brain.user.pastEve[eventObj.id];
				await forage({ mode: 'del', what: 'pastEve', id: eventObj.id });
			}
			setGalleryContent?.(prev => prev.filter(item => item.id !== eventObj.id));
			setModes(prev => ({ ...prev, deletePast: false, menu: false }));
		} catch (err) {
			handleRequestError(err, 'Nepodařilo se odstranit minulou událost.');
		}
	};

	const handleConfirmAction = action => {
		if (confirmStage === 1) setConfirmStage(2);
		else if (action === 'delete') deleteOwnEvent();
		else if (action === 'cancel') cancelOwnEvent();
		else if (action === 'deletePast') deletePastEvent();
	};

	// MENU CONFIGURATION --------------------------------------------------------
	// Define available menu actions and their conditions
	const menuSources = {
		invitees: galleryMode === 'invitesOut' ? () => toggleMode('invitees') : null,
		invitors: galleryMode === 'invitesIn' ? () => toggleMode('invitors') : null,
		otevřít: isCardOrStrip
			? () => {
					if (menuView) storeMenuViewState(menuView, galleryMode, eventObj.id);
					navigate(`/event/${eventObj.id}!${encodeURIComponent(eventObj.title).replace(/\./g, '-').replace(/%20/g, '_')}`);
			  }
			: null,
		náhled:
			galleryMode || isSearch
				? async () => {
						if (!modes.evePreview) await previewEveCard({ obj: eventObj, brain });
						toggleMode('evePreview');
				  }
				: null,
		účast: !galleryMode.includes('past') && !isInactive && (!own || (own && !status.isMeeting)) && isCardOrStrip ? async () => toggleMode('inter') : null,
		smazat: !undeletable && !status.deleted && (galleryMode === 'futuOwn' || !isCardOrStrip) && own && eventObj.state !== 'del' ? () => toggleMode('delete') : null,
		zrušit: !isInactive && (galleryMode === 'futuOwn' || !isCardOrStrip) && own && eventObj.starts > Date.now() && !eventObj.canceled ? () => toggleMode('cancel') : null,
		editovat:
			!galleryMode.includes('past') && !isInactive && (galleryMode || nowAt === 'event') && own
				? () => navigate(`/editor/${eventID}!${eventObj.title ? encodeURIComponent(eventObj.title.slice(0, 50)).replace(/\./g, '-').replace(/%20/g, '_') : ''}`)
				: null,
		sdílet: () => toggleMode('share'),
		'zpětná vazba': allowFeedback && !isInactive ? () => toggleMode('feedback') : null,
		kopírovat: () => copyTextsAndLink(),
		skrýt: galleryMode === 'pastSurMay' ? () => toggleMode('deletePast') : null,
		pozvat:
			!galleryMode.includes('invites') && !isInactive && eventObj.starts > Date.now()
				? () => {
						if (nowAt === 'editor') {
							window.scrollTo({ top: document.querySelector('invitations-container').getBoundingClientRect().top + window.scrollY, behavior: 'smooth' });
						} else {
							toggleMode('invite');
							userCardSetModes && userCardSetModes(prev => ({ ...prev, inviteEvePreview: !prev.inviteEvePreview, protocol: false }));
						}
				  }
				: null,
		nahlásit: !status.embeded && !isSearch && !own ? () => toggleMode('protocol', modes.protocol ? false : 'report') : null,
	};

	const hideMenu = modes.report || modes.evePreview;

	const confirmTexts = {
		del: 'Událost přestane být dostupná a její data budou smazána',
		del2: 'Událost bude PERMANENTNĚ ODSTRANĚNA. Toto je nevratné!',
		can: `Událost zůstane dostupná, avšak bez možnosti editace. Diskuze${
			eventObj.type.startsWith('a') ? ' a seznam účastníků zůstanou' : ' zůstane'
		} aktivní. Událost bude viditelně označená označena jako ZRUŠENÁ a automaticky smazaná po 90 dnech!`,
		can2: 'Zrušení události je nevratnou akcí! ',
		past: 'Permanentně skrýt tuto událost ze seznamu navštívených? Událost samotná zůstane nezměněna, stejně tak jako záznam o tvé účasti. Tato akce pouze skryje tento záznam v galerii. Toto je nevratné!',
		past2: 'Skrytí účasti je nevratnou akcí!',
	};

	// RENDER --------------------------------------------------------------------
	return (
		<event-menu onClick={e => e.stopPropagation()} class={'zinMenu posRel borTopLight '}>
			{/* STANDARD MENU BUTTONS */}
			{!hideMenu && (
				<MenuButtons
					{...{
						isCardOrStrip,
						nowAt,
						src: menuSources,
						thisIs: 'event',
						selButton: selectedButton,
						setSelButton: setSelectedButton,
						modes,
						copied,
						protocol,
						setMode: toggleMode,
						galleryMode,
					}}
				/>
			)}

			{/* CONFIRMATION DIALOGS (DELETE / CANCEL / HIDE PAST) */}
			{(modes.delete || modes.cancel || modes.deletePast) && (
				<confirm-box onClick={e => e.stopPropagation()} class='flexCol textAli  padVerXs padHorS borTopLight shaComment bgWhite'>
					<span className={`${confirmStage === 2 ? 'tDarkRed' : 'tRed'} xBold inlineBlock marTopS fs8 marBotXxxs`}>
						{confirmStage === 1 && (modes.delete ? 'Smazat událost?' : modes.cancel ? 'Zrušit událost?' : 'Skrýt v galerii?')}
						{confirmStage === 2 ? 'JSI SI ABSOLUTNĚ JISTÝ?!' : ''}
					</span>
					<span className='fs7 inlineBlock marBotS'>
						{modes.delete
							? confirmStage === 1
								? confirmTexts.del
								: confirmTexts.del2
							: modes.cancel
							? confirmStage === 1
								? confirmTexts.can
								: confirmTexts.can2
							: confirmStage === 1
							? confirmTexts.past
							: confirmTexts.past2}
					</span>
					{error && <span className='tRed fs9 xBold inlineBlock marVerXs'>{error}</span>}
					<button
						className={`${confirmStage === 2 ? 'bDarkRed' : confirmStage === 1 ? 'bRed' : 'bDarkGreen'} tWhite boRadXs padHorS padVerXs mw60 xBold marAuto w100 fs10`}
						onClick={() => {
							if (error) {
								const alreadyCanceled = error.includes('zrušeno');
								if (error === 'error' || alreadyCanceled) {
									setError('');
									setConfirmStage(1);
									setUndeletable(true);
									if (alreadyCanceled) setStatus(prev => ({ ...prev, canceled: true }));
									setModes(prev => ({ ...prev, delete: false, cancel: false, deletePast: false, menu: false }));
								} else {
									setError('');
									setConfirmStage(1);
									setUndeletable(true);
									setModes(prev => ({ ...prev, delete: false, cancel: true }));
								}
							} else handleConfirmAction(modes.delete ? 'delete' : modes.cancel ? 'cancel' : 'deletePast');
						}}>
						{error
							? error === 'error'
								? 'Chyba :-(, zkus to za chvilku znovu'
								: error.includes('zrušeno')
								? 'OK, rozumím'
								: 'NELZE SMAZAT, JEN ZRUŠIT!'
							: confirmStage === 2
							? `${modes.delete ? 'ANO, smazat událost!' : modes.cancel ? 'ANO, zrušit událost!' : 'ANO, skrýt v galerii!'}`
							: confirmStage === 1
							? 'Potvrdit'
							: 'Úspěšně provedeno'}
					</button>
				</confirm-box>
			)}

			{/* INVITATION MANAGER */}
			{(modes.invite || modes.invitees || modes.invitors) && (
				<Invitations
					{...{
						brain,
						obj: eventObj,
						onSuccess: () => {
							setModes(prev => ({ ...prev, invite: false }));
							if (userCardSetModes) userCardSetModes(prev => ({ ...prev, inviteEvePreview: false }));
						},
						invitesTotal,
						fetchMoreUsers,
						selectedItems: inviteUsers,
						invitesHandler: handleInviteAction,
						galleryMode,
						showUsersOnly: modes.invitees || modes.invitors,
						downMargin: !isCardOrStrip,
						setModes,
						topPadding: true,
						mode: 'eventToUsers',
					}}
				/>
			)}

			{/* BULK INVITE ACTIONS */}
			{(modes.invitees || modes.invitors) && (
				<bulk-actions onClick={e => e.stopPropagation()} className='w100 flexCen marTopXs'>
					<button onClick={handleBulkInvites} className='bRed tWhite bold fs7 padVerXxs padHorXl boRadXs'>
						{galleryMode === 'invitesOut' ? 'Zrušit všechny pozvánky' : 'Smazat všechny pozvánky'}
					</button>
				</bulk-actions>
			)}

			{/* SUB-COMPONENTS (INTERESTS / PROTOCOL / FEEDBACK) */}
			{modes.inter && <IntersPrivsButtons {...{ status, brain, nowAt, obj: eventObj, modes, setStatus, setModes }} />}
			{modes.protocol && <SimpleProtocol setModes={setModes} obj={eventObj} target={eventObj.id} modes={modes} thisIs={'event'} brain={brain} nowAt={nowAt} setStatus={setStatus} />}
			{modes.feedback && (
				<EventFeedbackProtocol
					obj={eventObj}
					brain={brain}
					isOwner={own}
					mode={galleryMode || isCardOrStrip ? 'modal' : 'inline'}
					onClose={() => setModes(prev => ({ ...prev, feedback: false, menu: false }))}
				/>
			)}
		</event-menu>
	);
}

export default EveMenuStrip;
