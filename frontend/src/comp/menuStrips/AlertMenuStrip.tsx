import { useState, useMemo } from 'react';
import axios from 'axios';
import MenuButtons from './stripButtonsJSX';
import { previewEveCard } from './helpers';
import { showUsersProfile } from '../../utils/userProfileUtils';
import EventCard from '../EventCard';
import UserCard from '../UserCard';
import IntersPrivsButtons from '../IntersPrivsButtons';
import { linksHandler } from '../../hooks/useLinksAndBlocks';
import { forage } from '../../../helpers';
import { updateGalleryArrays } from '../bottomMenu/Gallery/updateGalleryArrays';
import { notifyGlobalError } from '../../hooks/useErrorsMan';
import { storeMenuViewState } from '../LogoAndMenu';

/** ----------------------------------------------------------------------------
 * ALERT MENU STRIP COMPONENT
 * Manages actions for alerts/notifications (accept/refuse invite, reply to comment, etc.)
 * Handles complex alert-specific logic and UI updates.
 * -------------------------------------------------------------------------- */
function AlertMenuStrip(props) {
	const { alert, brain, onRemoveAlert, setMenuView, nowAt = 'alerts', buttons = [], status, modes, setModes, setStatus, storeAlertsData } = props;
	const { what, target, data = {} } = alert || {};
	const [selButton, setSelButton] = useState(null);
	const [interStatus, setInterStatus] = useState({ inter: null, interPriv: 'pub', surely: 0, maybe: 0, own: false, isMeeting: false });

	const setMode = (mode, value = undefined) => {
		setModes(prev => ({ ...Object.keys(prev).reduce((acc, key) => ({ ...acc, [key]: false }), {}), [mode]: value ?? prev[mode] !== true, menu: true }));
	};

	const openEvent = () => {
		const eid = data?.event || target;
		if (!eid) return;
		storeMenuViewState('alerts', null, alert?.id); // STORE ALERTS + ALERT ID FOR BACK NAVIGATION ---------------------------
		const title = data?.title || brain?.events?.[eid]?.title || '';
		const slug = encodeURIComponent(title).replace(/\./g, '-').replace(/%20/g, '_');
		window.location.href = `/event/${eid}${slug ? '!' + slug : ''}`;
	};

	// Local helper to sync invites structures and gallery categories
	const syncInvitesState = async ({ eid, inviterId, mode, interData }: any) => {
		try {
			brain.user.invitesIn ||= {};
			const list = (brain.user.invitesIn[eid] ||= []);
			const idx = list.findIndex(u => Number(u?.id) === Number(inviterId));

			if (mode === 'refuse' || mode === 'accept') {
				if (idx > -1) list.splice(idx, 1);
				if (list.length === 0) {
					delete brain.user.invitesIn[eid];
					updateGalleryArrays(brain, eid, { removeFromInvitesIn: true });
				}
			}

			// Reflect into event object for UI coherence
			const eve = (brain.events[eid] ||= { id: eid });
			eve.invites ||= {};
			eve.invites.in = brain.user.invitesIn[eid] || [];
			eve.invited = Array.isArray(eve.invites.in) && eve.invites.in.some(u => u && u.flag === 'ok');

			await forage({ mode: 'set', what: 'user', val: brain.user });
		} catch (e) {
			console.warn('Failed to sync invites state:', e);
		}
	};

	const handleInvite = async (mode, interData = null) => {
		try {
			const [inviterId, eid] = [data?.user, target];
			await axios.post('invites', { targetEvent: eid, targetUser: inviterId, mode });

			if (mode === 'refuse') {
				Object.assign(alert, { flag: 'ref', refused: true, accepted: false, inter: null, interPriv: null, decisionAt: Date.now() });
				setStatus(prev => ({ ...prev, refused: true, inter: null, interPriv: null }));
				await syncInvitesState({ eid, inviterId, mode });
				await storeAlertsData();
			} else if (mode === 'accept') {
				Object.assign(alert, { flag: 'acc', accepted: true, refused: false, inter: interData?.inter || null, interPriv: interData?.interPriv || null, decisionAt: Date.now() });
				setStatus(prev => ({ ...prev, accepted: true, inter: interData?.inter || null, interPriv: interData?.interPriv || null }));
				await syncInvitesState({ eid, inviterId, mode, interData });
				await storeAlertsData();
			}
			setModes(prev => ({ ...prev, menu: false }));
		} catch (e) {
			notifyGlobalError(e, 'Akce s pozvánkou selhala.');
		}
	};

	const handleLink = async mode => {
		try {
			const otherUser = data?.user || alert?.target;
			await linksHandler({ mode, id: otherUser, obj: { id: otherUser, ...data }, brain, note: data?.note, message: data?.message });
			Object.assign(alert, {
				flag: mode === 'refuse' ? 'ref' : 'acc',
				refused: mode === 'refuse',
				accepted: ['link', 'accept'].includes(mode),
				linked: mode === 'link' ? 'out' : mode === 'accept' ? true : false,
				decisionAt: Date.now(),
			});
			setStatus(prev => ({ ...prev, ...['refused', 'accepted', 'linked'].reduce((acc, key) => ({ ...acc, [key]: alert[key] }), {}) }));
			await storeAlertsData(), setModes(prev => ({ ...prev, menu: false }));
		} catch (e) {
			notifyGlobalError(e, 'Akce s propojením selhala.');
		}
	};

	// Build actions map
	const baseSrc = {
		otevřít: () => openEvent(),
		náhled: async () => {
			try {
				if (modes.evePreview) return setMode('evePreview', false);
				const eid = data?.event || target;
				if (eid) {
					const obj = brain?.events?.[eid] || { id: eid };
					await previewEveCard({ obj, brain }), setMode('evePreview', obj);
				}
			} catch (_) {}
		},
		profil: async () => {
			if (modes.profile) return setMode('profile', false);
			const uid = data.user || alert?.target;
			if (!uid) return;
			const obj = Object.assign((brain.users[uid] ??= {}), { id: uid, first: data.first, last: data.last, imgVers: data.imgVers });
			await showUsersProfile({
				obj,
				brain,
				setModes: newModes => {
					setModes({ ...newModes(), profile: newModes().profile ? obj : null, menu: Boolean(newModes().profile) });
				},
				modes,
				setStatus,
			});
		},
		odmítnout:
			status.refused || what === 'accept' || (what === 'link' && status.linked)
				? null
				: async () => {
						if (what === 'invite') {
							await handleInvite('refuse');
						} else if (what === 'link') {
							handleLink('refuse');
						}
				  },
		...(what === 'accept' || status.accepted
			? {
					odpojit: async () => {
						try {
							const uid = data?.user || alert?.target;
							await linksHandler({ mode: 'unlink', brain, id: uid, obj: brain.users[uid], setStatus, setModes });
						} catch (e) {
							notifyGlobalError(e, 'Odpojení se nepodařilo.');
						}
					},
			  }
			: {}),
		...((status.accepted && what === 'invite') || what === 'accept' || (what === 'link' && (status.accepted || status.linked))
			? null
			: {
					[status.inter ? 'účast' : status.refused ? 'připojit' : 'přijmout']: () => {
						what === 'invite'
							? (setSelButton(selButton === 'přijmout' ? null : 'přijmout'), setMode('inter'), true)
							: what === 'link'
							? handleLink(status.refused ? 'link' : 'accept')
							: null;
					},
			  }),
		smazat: async () => {
			try {
				await axios.post('alerts', { mode: 'delete', alertId: alert?.id });
				onRemoveAlert?.();
			} catch (e) {
				notifyGlobalError(e, 'Nepodařilo se smazat upozornění.');
			}
		},
		galerie:
			what === 'link' && status.refused
				? null
				: () => {
						const mapping = { invite: 'invitesIn', link: 'requests', accept: 'links' };
						const cat = status.accepted ? 'links' : mapping[what];
						if (!cat) return;
						brain.showGalleryCat = cat;
						setModes(prev => ({ ...prev, menu: null }));
						storeMenuViewState('alerts', null, alert?.id); // STORE ALERTS + ALERT ID FOR BACK NAVIGATION ---------------------------
						setMenuView?.('gallery');
				  },
	};

	// Filter only requested buttons
	const src = useMemo(() => {
		const filtered = {};
		for (const name of buttons) if (baseSrc[name]) filtered[name] = baseSrc[name];
		return filtered;
	}, [JSON.stringify(buttons), what, target, JSON.stringify(data), JSON.stringify(status), modes]);

	// RENDER --------------------------------------------------------------------
	return (
		<alert-menu onClick={e => e.stopPropagation()} class='shaBlue boRadXxs justCen aliStart w100  posRel bInsetBlueTopXxs bHover pointer shaBot borTopLight'>
			<MenuButtons {...{ isCardOrStrip: true, nowAt, src, thisIs: 'event', selButton, setSelButton, modes, setMode }} />

			{/* INTEREST BUTTONS SUB-COMPONENT */}
			{modes.inter && (
				<IntersPrivsButtons
					{...{
						brain,
						nowAt: 'alerts',
						obj: { id: data?.event || target, type: 2, title: data?.title || '' },
						status: interStatus,
						setStatus: newStatus => {
							const updated = newStatus();
							setInterStatus(updated);
							if (updated.inter) {
								setStatus(prev => ({ ...prev, inter: updated.inter, interPriv: updated.interPriv }));
								setModes(prev => ({ ...prev, privs: true }));
							} else if (updated.inter === false && status.inter && what === 'invite') {
								handleInvite('refuse');
							}
						},
						setModes: async newModes => {
							const updated = newModes();
							if (!updated.privs && !updated.inter) {
								if (interStatus.inter && what === 'invite') await handleInvite('accept', { inter: interStatus.inter, interPriv: interStatus.interPriv });
								else setModes(prev => ({ ...prev, inter: false, privs: false }));
							} else setModes(prev => ({ ...prev, ...updated }));
						},
						modes,
					}}
				/>
			)}
			{modes.profile && <UserCard brain={brain} obj={modes.profile} isProfile={true} nowAt='alerts' />}
			{modes.evePreview && <EventCard brain={brain} isPreview={true} obj={modes.evePreview} />}
		</alert-menu>
	);
}

export default AlertMenuStrip;
