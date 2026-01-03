import { useRef, useState, useEffect } from 'react';
import { forage } from '../../../../helpers';

function useChat(props) {
	// STATE & REFS ---------------------------------------------------------------------
	// Steps: keep small UI flags in React state, keep timers/history tracking in refs, and keep `chatObj.current` as the shared mutable “active chat” cursor used by handlers.
	const [hasPushedState, setHasPushedState] = useState(false),
		[isWrapped, setIsWrapped] = useState(false);
	const {
		chats,
		setChats,
		chatObj,
		setModes,
		setInform,
		notifDots,
		setNotifDots,
		menuView,
		openedChat,
		setOpenedChat,
		brain,
		manRef,
		setScrollDir,
		setCurView,
		mainWrapperRef,
		openedChatRef,
		chatsListRef,
		wrapTriggerRef,
		curView,
	} = props || {};
	const man = inp => manRef?.current?.(inp),
		[listEl, openedEl, mainWrapper] = [chatsListRef.current, openedChatRef.current, mainWrapperRef.current];
	const previousWrappedState = useRef(false),
		informTimeouts = useRef(new Set()),
		chatStoreTimeouts = useRef(new Map());

	// LIFECYCLE: CLEANUP ---------------------------------------------------------------
	// Clear all timeouts (inform, storage) when component unmounts or brain ref changes
	useEffect(
		() => () => {
			informTimeouts.current.forEach(t => clearTimeout(t as any));
			informTimeouts.current.clear();
			chatStoreTimeouts.current.forEach(t => clearTimeout(t as any));
			chatStoreTimeouts.current.clear();
			if (brain?.chatStoreInProg) Object.values(brain.chatStoreInProg).forEach(t => clearTimeout(t as any)), (brain.chatStoreInProg = {});
		},
		[brain]
	);

	// LIFECYCLE: INITIALIZATION --------------------------------------------------------
	// Handle view state and fetch initial chat list data when 'chats' view is active
	useEffect(() => {
		// VIEW ENTRY/EXIT ---------------------------------------------------------
		// Steps: on exit, reset to chats list; on entry, set scroll direction and decide which bootstrap action to run (launch setup, restore cached list, or fetch from server).
		if (menuView !== 'chats') {
			if (!menuView) run('reset'), setCurView('chats');
			return;
		}
		setScrollDir('up');
		const init = async () =>
			brain.newPrivateChat || (brain.chatSetupData && curView !== 'chatSetup')
				? man({ mode: 'launchSetup' })
				: brain.user.chatsList.length && !chats.length
				? await man({ mode: 'restoreChatsList' })
				: await man({ mode: 'getChats' });
		if (curView === 'chats' || !curView) init();
	}, [menuView, curView]);

	// UI: NOTIFICATION DOTS ------------------------------------------------------------
	// Clear 'chats' notification dot when entering the view
	useEffect(() => {
		if (menuView === 'chats' && notifDots?.chats) setNotifDots(prev => ({ ...prev, chats: 0 }));
	}, [menuView, notifDots?.chats]);

	// Update 'chats' and 'archive' dots based on unread messages in user's chat list
	useEffect(() => {
		if (!['chats', 'archive'].some(key => notifDots[key])) return;
		const isOk = chat => chat.members?.find(member => String(member.id) === String(brain.user.id))?.flag === 'ok';
		const check = isArchived => chats.some(chat => chat.archived === isArchived) && chats.filter(chat => isOk(chat) && chat.archived === isArchived).every(chat => chat.seen);
		setNotifDots(prev => ({ ...prev, chats: notifDots.chats && check(false) ? 0 : prev.chats, archive: notifDots.archive && check(true) ? 0 : prev.archive }));
	}, [menuView, openedChat, chats]);

	// UI: BACK BUTTON HANDLING ---------------------------------------------------------
	// Intercept browser back button to switch from 'openedChat' to 'chatsList'
	useEffect(() => {
		const handleBack = event => (event.preventDefault(), viewSwitch('chatsList'));
		window.addEventListener('popstate', handleBack);
		return () => window.removeEventListener('popstate', handleBack);
	}, []);

	// UI: RESPONSIVE LAYOUT (WRAPPED) --------------------------------------------------
	// Detect if chat list and opened chat are stacked (wrapped) due to screen size
	useEffect(() => {
		if (!openedChat) return (previousWrappedState.current = false), setIsWrapped(false);
		setIsWrapped(false);
		let frameId1,
			frameId2,
			resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => requestAnimationFrame(checkWrapped)));
		const checkWrapped = () => {
			if (!listEl || !openedEl || !mainWrapper) return;
			const isWrappedLayout = openedEl.offsetTop > listEl.offsetTop + 10,
				showBack = isWrappedLayout && mainWrapper.scrollHeight > mainWrapper.offsetHeight * 1.1;
			if (!previousWrappedState.current && showBack && openedChat) viewSwitch('openedChat');
			(previousWrappedState.current = showBack), setIsWrapped(showBack);
		};
		frameId1 = requestAnimationFrame(() => (frameId2 = requestAnimationFrame(checkWrapped)));
		if (mainWrapper) resizeObserver.observe(mainWrapper);
		return () => (cancelAnimationFrame(frameId1), cancelAnimationFrame(frameId2), resizeObserver.disconnect());
	}, [openedChat, menuView]);

	// NAVIGATION: VIEW SWITCHER --------------------------------------------------------
	// Toggles between chat list and opened chat view, managing scroll and history state
	function viewSwitch(target = 'openedChat') {
		if (target === 'chatsList') {
			if (mainWrapper?.scrollHeight > mainWrapper?.offsetHeight) (chatObj.current = {}), setOpenedChat(null), delete brain.openedChat;
			mainWrapper?.scrollTo({ top: 0 }), setHasPushedState(false);
		} else {
			const pushHistory = () => {
				if (hasPushedState) return;
				const [listElement, openedElement] = [chatsListRef.current, openedChatRef.current];
				if (listElement && openedElement)
					(mainWrapper.scrollHeight > mainWrapper.offsetHeight * 1.1 || openedElement.offsetTop > listElement.offsetTop) &&
						!hasPushedState &&
						(window.history.pushState({ page: 'chat' }, 'Chat'), setHasPushedState(true));
				else requestAnimationFrame(pushHistory);
			};
			pushHistory();
			const targetElement = openedChatRef.current || wrapTriggerRef.current;
			if (targetElement) mainWrapper.scrollTo({ top: targetElement.getBoundingClientRect().top - mainWrapper.getBoundingClientRect().top + mainWrapper.scrollTop - 8 });
		}
	}

	// UTILS: TIMED NOTIFICATIONS -------------------------------------------------------
	// Sets a temporary informational message with auto-clear timeout
	function setInformWithTimeout(message, duration = 2000) {
		setInform(prev => [...(Array.isArray(prev) ? prev : []), message]);
		const timeoutId = setTimeout(() => (setInform(prev => (Array.isArray(prev) ? prev.filter(w => w !== message) : [])), informTimeouts.current.delete(timeoutId)), duration);
		informTimeouts.current.add(timeoutId);
		return timeoutId;
	}

	// LOGIC: PUNISHMENT STATUS ---------------------------------------------------------
	// Evaluates if a member is currently punished (banned, kicked, blocked, gagged)
	function getPunishmentStatus(member, now = Date.now()) {
		// PUNISHMENT CLASSIFICATION -------------------------------------------
		// Steps: normalize until into ms, then translate punish mode into {active,expired} flags so UI can render consistent controls and auto-expire logic can be shared.
		const { punish, until, who, mess } = member || {},
			untilMs = until ? (typeof until === 'number' ? until : new Date(until).getTime()) : null;
		if (!punish) return false;
		if (punish === 'block') return { punish, active: String(who) !== String(brain.user.id), who, mess };
		if (punish === 'kick') return { punish, active: false, expired: true, who, mess };
		if (['ban', 'gag'].includes(punish)) return { punish, active: !untilMs || untilMs > now, expired: !!untilMs && untilMs <= now, until: untilMs, who, mess };
		return { punish, active: false, who, mess };
	}

	// CONTROLLER: MAIN ACTION RUNNER ---------------------------------------------------
	// Central handler for chat operations: refresh, reset, unshift, and storage
	function run(input, targetChat = chatObj.current) {
		// CENTRALIZED MUTATIONS ------------------------------------------------
		// Steps: keep chat list mutations and debounced persistence in one place so socket events and UI actions share ordering + storage semantics.
		if (input === 'refresh') setChats(prev => [...prev]);
		else if (input === 'refreshChatIdx') {
			const index = chats.findIndex(chat => String(chat.id) === String(targetChat.id));
			index !== -1 ? ((chatObj.current = Object.assign(chats[index], targetChat)), setChats(prev => (prev.splice(index, 1, { ...chatObj.current }), [...prev]))) : run('unshift', targetChat);
		} else if (input === 'reset') setModes(prev => ({ ...prev, menu: false, chatsMenu: false, searchChats: false, members: false }));
		else if (input === 'unshift') setChats(prev => [targetChat, ...prev.filter(chat => String(chat.id) !== String(targetChat.id))]);
		else if (input === 'store') {
			// DEBOUNCED STORE ---------------------------------------------------
			// Steps: debounce per-chat writes, persist only minimal fields needed to restore chat UI, then clear timeout handle.
			if (chatStoreTimeouts.current.has(targetChat.id)) clearTimeout(chatStoreTimeouts.current.get(targetChat.id));
			chatStoreTimeouts.current.set(
				targetChat.id,
				setTimeout(() => {
					const val = ['id', 'messages', 'members', 'membSync', 'seenSync', 'cursors', 'seen'].reduce((acc, key) => ({ ...acc, [key]: targetChat[key] }), {});
					forage({ mode: 'set', what: 'chat', id: targetChat.id, val });
					chatStoreTimeouts.current.delete(targetChat.id);
				}, 3000)
			);
		}
	}

	// LOGIC: MEMBER PROCESSING ---------------------------------------------------------
	// Syncs incoming member data, updates roles, handles deletions, and stores state
	function processChatMembers({ chatObj: chat, members: incomingMembers, membSync: sync }) {
		// APPLY MEMBER DELTAS -------------------------------------------------
		// Steps: normalize incoming roles, expire punishments for others, merge or mark del, sync self role to chat, then store and refresh ordering.
		if (!Array.isArray(incomingMembers) || !incomingMembers.length || !chat) return;
		if (!Array.isArray(chat.members)) chat.members = [];
		incomingMembers.forEach(incomingMember => {
			if (incomingMember.role === 'priv') incomingMember.role = 'member';
			// Check for expiration of punishments on EXISTING members
			chat.members = chat.members.map(currentMember => {
				const { expired } = getPunishmentStatus(currentMember) as any;
				if (expired && currentMember.id != brain.user.id) ['punish', 'until', 'who', 'mess'].forEach(key => delete currentMember[key]), (currentMember.role = 'member');
				return currentMember;
			});
			// Merge or add incoming member data
			const match = chat.members.find(member => member.id === incomingMember.id);
			match
				? incomingMember.flag === 'del'
					? (Object.assign(match, { flag: 'del', role: 'spect' }), ['punish', 'until', 'who', 'mess'].forEach(key => delete match[key]))
					: Object.assign(match, incomingMember)
				: chat.members.push(incomingMember);
			// Sync self role
			if (String(incomingMember.id) === String(brain.user.id)) Object.assign(chat, { role: incomingMember.role });
		});
		if (sync) chat.membSync = sync;
		chat.members.sort((a, b) => (a.id === brain.user.id ? -1 : b.id === brain.user.id ? 1 : 0));
		run('store', chat), run('refreshChatIdx', chat);
	}

	return { getPunishmentStatus, run, setInformWithTimeout, viewSwitch, hasPushedState, isWrapped, processChatMembers };
}

export default useChat;
