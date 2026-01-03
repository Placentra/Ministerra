import axios from 'axios';
import { fetchOwnProfile, forage, setPropsToContent, splitStrgOrJoinArr } from '../../helpers';
import { updateGalleryArrays } from '../comp/bottomMenu/Gallery/updateGalleryArrays';
import { notifyGlobalError } from '../hooks/useErrorsMan';

// SHOW USER PROFILE ------------------------------------------------------------
// Steps: toggle off if already open, resolve target user (self/local cache/HTTP), handle “blocked” special-case by pruning local arrays, then push the resolved profile into brain content and switch UI modes.
export const showUsersProfile = async ({ obj, brain, chatObj = {}, setModes, modes, setStatus = () => {} }: any) => {
	if (modes.profile && String(modes.profile.id) === String(obj.user || obj.id)) return setModes(prev => ({ ...prev, profile: null }));

	let profileObj;
	const targetID = obj.user || obj.id;
	const storedUser = brain.users[targetID];
	// SELF PROFILE --------------------------------------------------------------
	// Steps: if viewing self, ensure own profile is hydrated, persist user snapshot, then reuse brain.user as the profile object.
	if (targetID === brain.user.id) !brain.user.priv && (await fetchOwnProfile(brain)), forage({ mode: 'set', what: 'user', val: brain.user }), (profileObj = brain.user);
	else if (storedUser?.state !== 'basi') {
		try {
			// REMOTE FETCH ------------------------------------------------------
			// Steps: request profile from backend, then merge into existing objects so references held by UI remain valid.
			const profile = (await axios.post('/user', { id: targetID, mode: 'profile', ...(storedUser?.state === 'meta' && { basiOnly: true }) })).data || {};

			profileObj = Object.assign(storedUser || chatObj.members?.find(user => user.id === targetID) || obj, { ...profile, state: 'basi' });
			if (!storedUser) brain.users[targetID] = profileObj;
			splitStrgOrJoinArr(profileObj, 'split'), forage({ mode: 'set', what: 'users', id: profileObj.id, val: profileObj });
		} catch (err) {
			const errorData = err.response?.data;
			const errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
			if (errorCode === 'blocked') {
				// BLOCKED ---------------------------------------------------------
				// Steps: mark target unavailable, close menus, update local status flags, and remove from link/trusts arrays so UI doesn’t keep showing unreachable user.
				obj.unavail = true;
				obj.linked = false;
				setModes(prev => ({ ...prev, menu: false }));
				setStatus(prev => ({ ...prev, blocked: true, linked: false, trusts: false, unavail: true }));
				updateGalleryArrays(brain, targetID, { removeFromLinks: true, removeFromTrusts: true });
				const linkUsers = (brain.user.unstableObj || brain.user).linkUsers;
				const linkIdx = linkUsers.findIndex(link => link[0] === targetID);
				if (linkIdx !== -1) linkUsers.splice(linkIdx, 1);
			}
			notifyGlobalError(err, typeof errorData === 'object' ? errorData?.message : 'Profil se nepodařilo načíst.');
		}
	} else profileObj = storedUser;

	setPropsToContent('users', [profileObj], brain);

	setModes(prev => ({ ...Object.keys(prev || {}).reduce((acc, key) => ({ ...acc, [key]: false }), {}), profile: profileObj }));
};
