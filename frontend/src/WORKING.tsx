import { useState, useContext } from 'react';
import axios from 'axios';
import { forage, fetchOwnProfile } from '../../../helpers';
import MenuButtons from './MenuButtons';
import SimpleProtocol from '../SimpleProtocol';
import { globalContext } from '../../contexts/globalContext';
import UserCard from '../UserCard';
import { notifyGlobalError } from '../../hooks/useErrorsMan';

export const showUsersProfile = async ({ obj, brain, chatObj = {}, setModes }: any) => {
	let profileObj;
	if (obj.id === brain.user.id) !brain.user.priv && (await fetchOwnProfile(brain)), forage({ mode: 'set', what: 'user', val: brain.user }), (profileObj = brain.user);
	else {
		const storedUser = brain.users[obj.id || obj.user];
		if (storedUser?.state !== 'basi') {
			try {
				const basiData = (await axios.post('user', { id: obj.id, mode: 'getProfile' })).data || {};
				profileObj = Object.assign(storedUser || chatObj.members?.find(u => u.id === obj.user) || obj, { ...basiData, state: 'basi' });
				if (!storedUser) brain.users[obj.id || obj.user] = profileObj;
				forage({ mode: 'set', what: 'users', val: brain.users });
			} catch (error) {
				notifyGlobalError(error, 'Nepodařilo se načíst profil.');
				return;
			}
		} else profileObj = storedUser;
	}
	setModes(p => ({ ...p, profile: profileObj }));
};

const UserMenuStrip = ({ obj = {}, chatObj = {}, modes = {}, setStatus, isNarrow, galleryMode, isChatMember, isSearch, brain = {}, status = {}, setModes, nowAt }: any) => {
	const { id } = obj,
		[selButton, setSelButton] = useState(null),
		[{ linked, blocked }, { protocol }] = [status, modes],
		role = chatObj.members?.find(m => m.id === brain.user.id)?.role,
		{ setMenuView } = useContext(globalContext);
	const updateArray = (mode, id, target) => {
		const obj = Array.isArray(target) ? { default: target } : target;
		for (const key in obj) obj[key] = mode === 'filter' ? obj[key].filter(x => (x[0] || x) !== id) : [id, ...obj[key]];
	};

	const linksHandler = async ({ mode, note, message }) => {
		const [linkActions, linkStates, linkUsers] = [['create', 'unlink', 'confirm', 'refuse', 'cancel'], ['out', false, true, false, false], (brain.user.unstableObj || brain.user).linkUsers],
			[galleryLinks, galleryRequests] = ['links', 'requests'].map(k => brain.user.galleryIDs[k]);
		try {
			await axios.post('user', { mode, id });
		} catch (error) {
			notifyGlobalError(error, 'Akce se nezdařila.');
			throw error;
		}
		if (['refuse', 'cancel', 'unlink'].includes(mode)) updateArray('filter', id, linkUsers), updateArray('filter', id, mode === 'unlink' ? galleryLinks : galleryRequests);
		else if (mode === 'create') {
			linkUsers.unshift([id, 'out', new Date().toISOString().replace('T', ' ').slice(0, 19), note]), updateArray('add', id, galleryRequests);
			if (message.length) setupNewChat({ content: message });
		} else if (mode === 'confirm') updateArray('filter', id, galleryRequests), updateArray('add', id, galleryLinks), (linkUsers.find(link => link[0] === id)[2] = 'ok');
		Object.assign(obj, { linked: linkStates[linkActions.indexOf(mode)] || false }), setStatus(p => ({ ...p, linked: obj.linked })), forage({ mode: 'set', what: 'user', val: brain.user });
		setModes && setModes(p => ({ ...p, menu: false }));
	};

	const blocksHandler = async () => {
		const mode = blocked ? 'unblock' : 'block';
		try {
			await axios.post('user', { mode, id });
		} catch (error) {
			notifyGlobalError(error, 'Nepodařilo se změnit blokování.');
			throw error;
		}
		(brain.users[id].state = 'del'), Object.assign(obj, { blocked: mode === 'block' });
		setStatus(p => ({ ...p, blocked: obj.blocked })), setModes(p => ({ ...p, menu: mode !== 'block' }));
		mode === 'block' && updateArray('remove', id, (brain.user.unstableObj || brain.user).linkUsers);
	};

	const setupNewChat = async ({ content }: any = {}) => ((brain.chatSetupData = { launchSetup: true, type: 'private', members: [obj], content }), setMenuView('chat'));

	const src = {
		profil: !obj.blocked && galleryMode !== 'blocks' && isNarrow && !isSearch ? () => showUsersProfile({ obj, brain, chatObj, setModes }) : null,
		pozvat: linked === 'ok' ? () => setModes(p => ({ ...p, invite: true })) : null,
		připojit: !obj.blocked && (!linked || linked === 'ref') && obj.id !== brain.user.id ? () => setModes(p => ({ ...p, protocol: p.protocol === 'link' ? false : 'link' })) : null,
		blokovat: !isChatMember && !blocked && linked !== 'out' && obj.id !== brain.user.id ? () => blocksHandler() : null,
		zpráva: !obj.blocked && obj.id !== brain.user.id && chatObj.type !== 'private' ? e => (e.stopPropagation(), setupNewChat()) : null,
		nahlásit: obj.id !== brain.user.id && !status.embeded && !isSearch ? () => setModes(p => ({ ...p, protocol: p.protocol === 'report' ? false : 'report', rate: false })) : null,
		potrestat:
			chatObj.type !== 'private' && !isSearch && !galleryMode && obj.role === 'member' && role !== 'member' && obj.id !== brain.user.id
				? () => setModes(p => ({ ...p, protocol: p.protocol === 'punish' ? false : 'punish' }))
				: null,
		odpojit: linked === 'ok' ? () => linksHandler({ mode: 'unlink' }) : null,
		zrušit: linked === 'out' ? () => linksHandler({ mode: 'cancel' }) : null,
		odmítnout: linked === 'in' ? () => linksHandler({ mode: 'refuse' }) : null,
		přijmout: linked === 'in' ? () => linksHandler({ mode: 'accept' }) : null,
	};

	return (
		<user-menu>
			<MenuButtons {...{ isNarrow, nowAt, src, thisIs: 'user', selButton, setSelButton, modes, protocol }} />
			{modes.profile && (
				<UserCard
					obj={{ ...modes.profile, ...(obj.first ? obj : chatObj.members.find(m => m.id === obj.user)) }}
					cardsView={brain.user.cardsView.users}
					isProfile={true}
					brain={brain}
					setModes={setModes}
				/>
			)}
			{modes.protocol && <SimpleProtocol setModes={setModes} superMan={linksHandler} target={obj.id} modes={modes} thisIs={'user'} brain={brain} nowAt={nowAt} setStatus={setStatus} />}
		</user-menu>
	);
};

export default UserMenuStrip;
