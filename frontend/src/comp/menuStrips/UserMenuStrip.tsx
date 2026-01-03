import { useState, useContext } from 'react';
import MenuButtons from './stripButtonsJSX';
import SimpleProtocol from '../SimpleProtocol';
import { globalContext } from '../../contexts/globalContext';
import UserCard from '../UserCard';
import Invitations from '../Invitations';
import { showUsersProfile } from '../../utils/userProfileUtils';
import { linksHandler, blocksHandler } from '../../hooks/useLinksAndBlocks';
import { storeMenuViewState } from '../LogoAndMenu';

/** ----------------------------------------------------------------------------
 * USER MENU STRIP COMPONENT
 * Manages action menu for users (link, block, message, trust, invite, etc.)
 * Handles friend requests, trust levels, and protocol actions.
 * -------------------------------------------------------------------------- */
const UserMenuStrip = props => {
	const {
		obj = {},
		chatObj = {},
		modes = {},
		setStatus = () => {},
		isCardOrStrip = false,
		galleryMode = '',
		isChatMember = false,
		isSearch = false,
		brain = {},
		status = {},
		setModes = () => {},
		nowAt = '',
		isEventPreview = false,
		isPast = false,
		removeAlert = null,
		superMan = null,
	} = props;
	const { id } = obj,
		[selButton, setSelButton] = useState(null),
		[{ blocked, trusts, linked }, { protocol }] = [status, modes],
		role = chatObj.members?.find(m => m.id === brain.user.id)?.role,
		hasRole = role !== 'member';
	const { setMenuView, menuView } = useContext(globalContext),
		[success, setSuccess] = useState(false),
		[error, setError] = useState(null);

	// ACTION: SETUP NEW CHAT ------------------------------------------------
	const setupNewChat = ({ content }: any = {}) => {
		brain.newPrivateChat = { otherMember: obj, content };
		storeMenuViewState(menuView === 'gallery' ? 'gallery' : menuView || 'chats', galleryMode || null, id);
		if (menuView !== 'chats') setMenuView('chats');
		else if (superMan) superMan({ mode: 'launchSetup' });
		else setMenuView(null), setTimeout(() => setMenuView('chats'), 0);
	};

	const setMode = (m, v = undefined) => setModes(p => ({ ...Object.keys(p).reduce((acc, k) => ({ ...acc, [k]: false }), {}), actions: true, menu: modes.menu, [m]: v !== undefined ? v : !p[m] }));

	// ACTION: HANDLE TRUST --------------------------------------------------
	const handleTrust = async () => {
		try {
			await linksHandler({ mode: 'trust', brain, id, obj, setStatus, setModes });
			setSuccess(true);
			setError(null);
			setTimeout(() => (setSuccess(false), setModes(p => ({ ...p, trust: false }))), 3000);
		} catch (e) {
			console.error(e);
			setError('Chyba :-( zkus to za chvilku znovu');
			setTimeout(() => (setError(null), setModes(p => ({ ...p, trust: false }))), 3000);
			setSuccess(false);
		}
	};
	const propss = { brain, id, obj, setStatus, setModes };

	// MENU ACTIONS MAPPING --------------------------------------------------
	const src = Object.fromEntries(
		Object.entries({
			připojit: !obj.blocked && !obj.trusts && !obj.linked && obj.id != brain.user.id ? () => setMode('protocol', protocol ? false : 'link') : null,
			přijmout:
				galleryMode === 'requests' && obj.linked === 'in'
					? async () => {
							await linksHandler({ mode: 'accept', ...propss });
							removeAlert?.();
					  }
					: null,
			odmítnout:
				galleryMode === 'requests' && obj.linked === 'in'
					? async () => {
							await linksHandler({ mode: 'refuse', ...propss });
							removeAlert?.();
					  }
					: null,
			'zrušit žádost': (!galleryMode || galleryMode === 'requests') && obj.linked === 'out' ? () => linksHandler({ mode: 'cancel', ...propss }) : null,
			profil:
				!obj.blocked && !isPast && isCardOrStrip
					? async () => showUsersProfile({ obj, brain, chatObj, setModes: n => setModes({ ...n(), profile: n().profile || null, menu: true }), modes, setStatus })
					: null,
			důvěřovat: !trusts && (galleryMode === 'requests' ? linked === true : galleryMode === 'links' ? linked !== false : false) ? () => setMode('trust', modes.trust ? false : true) : null,
			oddůvěřit: ['links', 'trusts'].includes(galleryMode) && trusts ? () => linksHandler({ mode: 'untrust', ...propss }) : null,
			pozvat: !status.blocked && obj.id !== brain.user.id && (galleryMode !== 'requests' || (obj.linked === true && obj.id !== brain.user.id)) ? () => setMode('invite') : null,
			blokovat: !isSearch && !isChatMember && !status.blocked && obj.id !== brain.user.id ? () => blocksHandler({ ...propss, mode: blocked ? 'unblock' : 'block' }) : null,
			odblokovat: status.blocked ? () => blocksHandler({ ...propss, mode: 'unblock' }) : null,
			zpráva: !obj.blocked && (!chatObj.type || chatObj.type !== 'private') ? e => (e.stopPropagation(), setupNewChat()) : null,
			nahlásit: !isEventPreview && obj.id !== brain.user.id && !status.embeded && !isSearch ? () => setMode('protocol', modes.protocol === 'report' ? false : 'report') : null,
			tresty:
				chatObj.type !== 'private' && !isSearch && !galleryMode && obj.role === 'member' && hasRole && obj.id !== brain.user.id
					? () => setMode('protocol', modes.protocol === 'punish' ? null : 'punish')
					: null,
			odpojit: linked === true ? () => linksHandler({ mode: 'unlink', ...propss }) : null,
			poznámka: galleryMode === 'links' || galleryMode === 'trusts' ? () => setMode('protocol', modes.protocol === 'note' ? false : 'note') : null,
		}).filter(([, v]) => v)
	);

	const hide = ['protocol', 'profile', 'invite'].some(b => modes[b]);

	// RENDER ------------------------------------------------------------------
	return (
		<user-menu class={`zinMaXl posRel  w100`} onClick={e => e.stopPropagation()}>
			{!hide && <MenuButtons {...{ isCardOrStrip, nowAt, src, thisIs: 'user', selButton, setSelButton, modes, protocol, setMode, isBlocked: status.blocked, galleryMode }} />}

			{/* TRUST CONFIRMATION */}
			{modes.trust && (
				<confirm-box onClick={e => e.stopPropagation()} class='flexCol textAli padVerXs padHorS borTopLight shaComment bgWhite'>
					<span className={`tDarkBlue xBold inlineBlock marTopS fs8 marBotXxxs`}>Přidat do důvěrných?</span>
					<span className='fs7 inlineBlock marBotS'>
						Důvěrní uživatelé představují izolovaný seznam tvých spojenců s nimiž máš velmi vřelý vztah a chceš je mít možnost jednoduše zacílit svým obsahem (událostmi, komentáři apod.) a
						nebo dle potřeby omezit viditelnost (soukromí) tvého obsahu pouze na ně. Důvěrníci vidí totéž co tvoji spojenci (opačně to platit nemusí)
					</span>
					<button className={`${error ? 'bDarkRed' : success ? 'bDarkGreen' : 'bDarkBlue'} tWhite boRadXs padHorS padVerXs mw60 xBold marAuto w100 fs10`} onClick={handleTrust}>
						{error ? 'Chyba :-(, zkus to za chvilku znovu' : success ? 'ÚSPĚŠNĚ PROVEDENO!' : 'Ano přidat do důvěrných'}
					</button>
				</confirm-box>
			)}

			{/* SUB-COMPONENTS (PROFILE / INVITE / PROTOCOL) */}
			{modes.profile && (
				<UserCard
					obj={{ ...modes.profile, ...(obj.first ? obj : chatObj.members.find(m => m.id === obj.user)) }}
					cardsView={brain.user.cardsView.users}
					isProfile={true}
					galleryMode={galleryMode}
					brain={brain}
					setModes={setModes}
				/>
			)}
			{modes.invite && <Invitations mode='userToEvents' brain={brain} obj={obj} onSuccess={() => setModes(p => ({ ...p, menu: false, invite: false }))} setModes={setModes} />}
			{modes.protocol && (
				<SimpleProtocol
					setModes={setModes}
					superMan={async p => (modes.protocol === 'punish' ? await superMan(p) : await linksHandler({ ...p, ...propss }))}
					obj={obj}
					target={obj.id}
					modes={modes}
					thisIs={'user'}
					brain={brain}
					nowAt={nowAt}
					setStatus={setStatus}
					chatObj={chatObj}
					chatID={chatObj?.id}
				/>
			)}
		</user-menu>
	);
};

export default UserMenuStrip;
