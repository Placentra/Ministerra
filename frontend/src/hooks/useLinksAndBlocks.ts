import axios from 'axios';
import { forage } from '../../helpers';
import { updateGalleryArrays } from '../comp/bottomMenu/Gallery/updateGalleryArrays';
import { notifyGlobalError } from './useErrorsMan';
const validStates = new Set(['mini', 'basi']);

/** ----------------------------------------------------------------------------
 * LINKS HANDLERS
 * Manages user connections (linking, trusting, accepting, refusing).
 * Updates local state, gallery arrays, and IndexedDB.
 * -------------------------------------------------------------------------- */
export const linksHandler = async ({ mode, note, obj = {}, message, id, brain, direct = 'out', isSocket, setStatus, setModes }: any) => {
	// INPUT NORMALIZATION ------------------------------------------------------
	// Steps: merge cached user snapshot into obj (to keep references stable), normalize state into a minimal renderable state, then carry inbound message only when server origin is inbound.
	const existingUser = brain.users[id] || {};
	const inboundMessage = direct === 'in' ? (message !== undefined ? message : existingUser.message ?? obj?.message) : undefined;
	Object.assign(obj, existingUser, {
		id,
		state: validStates.has(existingUser.state) ? existingUser.state : 'mini',
		note,
	});
	if (inboundMessage !== undefined) obj.message = inboundMessage;

	const [linkActions, linkStates, linkUsers] = [
		['link', 'unlink', 'accept', 'refuse', 'cancel', 'trust', 'untrust'],
		[direct, false, true, false, false, true, true],
		(brain.user.unstableObj || brain.user).linkUsers,
	];

	// SERVER MUTATION ---------------------------------------------------------
	// Steps: call backend unless this is already a socket-driven state change; if backend says alreadyLinked, reinterpret as accept; otherwise ignore noUpdate and surface real errors.
	try {
		if (!isSocket) await axios.post('user', { mode, id, note, message });
	} catch (error) {
		if (error?.response?.data === 'alreadyLinked') mode = 'accept';
		else if (error?.response?.data !== 'noUpdate') {
			notifyGlobalError(error, 'Nepodařilo se provést akci s propojením.');
			throw error;
		}
	}

	// LOCAL INDEX UPDATES ------------------------------------------------------
	// Steps: mutate galleryIDs buckets and user.linkUsers list first (so UI filters immediately reflect), then apply flags on obj for the profile/UI components.
	if (['refuse', 'cancel', 'unlink'].includes(mode)) {
		if (mode === 'unlink') updateGalleryArrays(brain, id, { removeFromLinks: true, removeFromTrusts: true });
		else updateGalleryArrays(brain, id, { removeFromRequests: true });
		const idx = linkUsers.findIndex(link => Number(link[0]) === Number(id));
		if (idx > -1) linkUsers.splice(idx, 1);
	} else if (mode === 'link') updateGalleryArrays(brain, id, { addToRequests: true });
	else if (mode === 'accept') {
		const idx = linkUsers.findIndex(link => Number(link[0]) === Number(id));
		if (idx === -1) linkUsers.push([id]);
		updateGalleryArrays(brain, id, { addToLinks: true, removeFromRequests: true });
	} else if (mode === 'trust') {
		const idx = linkUsers.findIndex(link => Number(link[0]) === Number(id));
		if (idx === -1) linkUsers.push([id, 'tru']);
		else linkUsers[idx][1] = 'tru';
		updateGalleryArrays(brain, id, { addToTrusts: true, addToLinks: true });
	} else if (mode === 'untrust') {
		const idx = linkUsers.findIndex(link => Number(link[0]) === Number(id));
		if (idx > -1) linkUsers[idx][1] = null;
		updateGalleryArrays(brain, id, { removeFromTrusts: true });
	}

	// APPLY FLAGS -----------------------------------------------------------
	// Steps: derive linked/trusts from the action index (or explicit trust/untrust/unlink), update UI state, then close menus to reflect “action committed”.
	const linkActionIndex = linkActions.indexOf(mode);
	if (linkActionIndex !== -1) {
		const nextLinked = linkStates[linkActionIndex] || false;
		const nextTrusts = mode === 'trust' ? true : mode === 'untrust' || mode === 'unlink' ? false : obj.trusts;
		Object.assign(obj, {
			linked: nextLinked,
			trusts: nextTrusts,
			note,
			...(inboundMessage !== undefined ? { message: inboundMessage } : {}),
		});
		setStatus?.(prev => ({ ...prev, linked: obj?.linked, trusts: obj?.trusts })), setModes?.(prev => ({ ...prev, menu: false }));
	} else if (mode === 'note') setModes?.(prev => ({ ...prev, menu: false, editNote: false }));

	// PERSISTENCE -------------------------------------------------------------
	// Steps: write user snapshot + current-user snapshot to forage so refresh/fast-load sees the same link graph; do not await so UI stays snappy.
	brain.users[id] = obj;
	forage({ mode: 'set', what: 'users', id, val: obj }), forage({ mode: 'set', what: 'user', val: brain.user });
};

/** ----------------------------------------------------------------------------
 * BLOCKS HANDLERS
 * Manages user blocking/unblocking.
 * Updates local state, removes links/trust, and updates gallery arrays.
 * -------------------------------------------------------------------------- */
export const blocksHandler = async ({ brain, id, mode, isSocket = false, setStatus, direct = 'out', setModes }: any) => {
	// INPUT + GRAPH ACCESS ------------------------------------------------------
	// Steps: take the shared linkUsers list (unstable or stable), take cached user snapshot (or minimal stub), then optionally run server mutation first so local state only changes on success.
	const linkUsers = (brain.user.unstableObj || brain.user).linkUsers;
	const existing = brain.users[id] || { id };
	if (!isSocket)
		try {
			await axios.post('user', { mode, id });
		} catch (error) {
			notifyGlobalError(error, 'Nepodařilo se upravit blokování.');
			throw error;
		}

	if (mode === 'block') {
		// LOCAL BLOCK --------------------------------------------------------
		// Steps: set blocked and clear linked/trusts (block implies no relationship), update UI status, remove from linkUsers, then update gallery buckets (optionally add to blocks only for outbound block).
		Object.assign(existing, { blocked: true, linked: false, trusts: false });
		brain.users[id] = existing;
		setStatus?.(prev => ({ ...prev, blocked: true, linked: false, trusts: false }));
		setModes?.(prev => ({ ...prev, menu: direct !== 'in' }));

		// Remove from linkUsers map
		const linIdx = linkUsers.findIndex(link => Number(link[0]) === Number(id));
		if (linIdx !== -1) linkUsers.splice(linIdx, 1);

		// Remove from all user categories; only add to Blocks if we initiated the block
		updateGalleryArrays(brain, id, {
			removeFromLinks: true,
			removeFromRequests: true,
			removeFromTrusts: true,
			...(direct === 'out' ? { addToBlocks: true } : {}),
		});

		await forage({ mode: 'set', what: 'users', id, val: existing });
		await forage({ mode: 'set', what: 'user', val: brain.user });
		return;
	}

	// UNBLOCK ---------------------------------------------------------------
	// Steps: clear blocked flag, remove from blocks bucket (outbound only), close menus, then persist.
	if (mode === 'unblock') {
		if (existing) existing.blocked = false;
		updateGalleryArrays(brain, id, { removeFromBlocks: direct === 'out' }), (brain.users[id] = existing);
		setStatus?.(prev => ({ ...prev, blocked: false })), setModes?.(prev => ({ ...prev, menu: false }));
		await forage({ mode: 'set', what: 'users', id, val: existing });
		await forage({ mode: 'set', what: 'user', val: brain.user });
		return;
	}
};
