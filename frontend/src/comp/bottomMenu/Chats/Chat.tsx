// CHAT SYSTEM SHELL ---
// Central orchestrator for the application's real-time messaging system.
// Manages chat lists, room initialization, socket communication, and message synchronization.
import { useState, useRef, lazy, Suspense, memo, useLayoutEffect } from 'react';
import { forage, createSubsetObj, delUndef, fetchOwnProfile } from '../../../../helpers';
import axios from 'axios';
const ChatSetup = lazy(() => import('../../ChatSetup'));
import OpenedChat from '../../OpenedChat';
import ChatsList from '../../ChatsList';
import useScrollDir from '../../../hooks/useScrollDir';
import useSocketIO from '../../../hooks/useSocketIO';
import { notifyGlobalError } from '../../../hooks/useErrorsMan';
import useChat from './useChat';
import { createQuickActions } from './quickActions';
import { handleChatSetupLogic } from './chatSetupLogic';

export function Chat(props) {
	// PROPS AND STATE INITIALIZATION ---------------------------
	const { brain, setMenuView, notifDots, setNotifDots, menuView, showToast } = (props || {}) as any,
		[chats, setChats] = useState<any[]>([]),
		[chatSetupData, setChatSetupData] = useState<any>(null),
		wrapTriggerRef = useRef<any>(null),
		// UI MODES ---------------------------
		[modes, setModes] = useState<any>({ protocol: false, selected: false, invite: false, members: false, searchChats: false, chatsMenu: false, menu: false }),
		[openedChat, setOpenedChat] = useState(brain.openedChat),
		chatObj = useRef<any>(chats?.find(chat => chat.id === openedChat) || {}),
		[curView, setCurView] = useState('chats'), // chats | archive | inactive | hidden | chatSetup ---------------------------
		[foundSimilarChats, setFoundSimilarChats] = useState(null),
		[selSimilarChatID, setSelOldChatID] = useState(false),
		[inform, setInform] = useState([]),
		[scrollDir, setScrollDir] = (useScrollDir as any)(),
		hideChatsMenuTimeout = useRef<any>(null),
		openedChatRef = useRef<any>(null),
		chatsListRef = useRef<any>(null),
		mainWrapperRef = useRef<any>(null),
		infinityTrigger = useRef<any>(null),
		bottomScroll = useRef<any>(null),
		informScroll = useRef<any>(null),
		didFetchChats = useRef({ chats: false, archive: false, inactive: false, hidden: false }),
		lastFetchTime = useRef({ chats: 0, archive: 0, inactive: 0, hidden: 0 }),
		manRef = useRef<any>(null);

	// CORE CHAT HOOK ---------------------------
	// Abstracts complex state mutations and visual feedback logic.
	const { getPunishmentStatus, run, setInformWithTimeout, viewSwitch, hasPushedState, isWrapped, processChatMembers } = useChat({
		chats,
		setChats,
		chatObj,
		setModes,
		setInform,
		notifDots,
		setNotifDots,
		menuView,
		openedChat,
		chatsListRef,
		openedChatRef,
		mainWrapperRef,
		setScrollDir,
		brain,
		manRef,
		curView,
		setCurView,
		setOpenedChat,
		wrapTriggerRef,
	});

	// SYNC MENUVIEW TO BRAIN FOR SOCKET HANDLERS ---------------------------
	brain.menuView = menuView;

	// REAL-TIME COMMUNICATION ---------------------------
	// Initializes and manages the socket.io connection for incoming messages and updates.
	const { socket } = useSocketIO({
		brain,
		setChats,
		chats,
		thisIs: 'chats',
		setMenuView,
		setNotifDots,
		bottomScroll,
		processChatMembers: processChatMembers as any,
		run,
		man,
		showToast,
		setScrollDir,
	});

	// BUG must prevent removing members so that there is always at least two members in a chat
	// TODO might add a once in XY minutes check when opening chat, and compare neest mesage ID with the chats last message ID to see if there are new messages just to be sure (or can we rely on socket only?)

	// CHATS MANAGER -----------------------------------------------------------
	// Unified command handler for all chat-related operations.
	// Orchestrates data fetching, UI transitions, state synchronization, and background syncs.
	async function man(inp) {
		console.log('🚀 ~ man ~ inp:', inp);
		setInform([]);
		const getMembersObj = () => members.find(member => String(member.id) === String(brain.user.id));
		const { attach, content, chatType, targetUserID, until, messID, userObj } = inp;
		let [{ chatID, mode, id, getNewest }, data, response] = [inp, { ...brain.chatSetupData }, {} as any];

		// GETTING CHAT FLAG GROUPS --------------------------------------------
		// Filters and sorts chats based on their current state (active, archived, hidden, etc.)
		const targetChats = (
			(inp._chatsOverride || chats).filter(chat => {
				const myFlag = chat.members?.find(m => String(m.id) === String(brain.user.id))?.flag;
				if (mode === 'getChats') return myFlag === 'ok' && !chat.archived && !chat.hidden;
				else if (mode === 'getInactiveChats') return myFlag === 'del';
				else if (mode === 'getArchivedChats') return chat.archived;
				else if (mode === 'getHiddenChats') return chat.hidden;
				return false;
			}) || []
		).sort((a, b) => b.messages?.slice(-1)[0]?.id - a.messages?.slice(-1)[0]?.id);

		// GET CHAT OBJECT -----------------------------------------------------
		// Retrieves or initializes the current chat context from memory or search results.
		if (mode === 'launchSetup' && !chatID) {
			chatObj.current = {};
		} else {
			chatObj.current =
				[...chats, ...(foundSimilarChats || [])].find(chat => {
					return chat.id === (chatID || chatSetupData?.id || selSimilarChatID || chatObj.current?.id);
				}) || {};
		}

		const { cursors, members, messages, opened, membSync, seenSync } = chatObj.current;
		const { punish, who } = (getPunishmentStatus((members || []).find(member => String(member.id) === String(brain.user.id)) || {}) as any) || {};

		// RESTORE CHATS LIST --------------------------------------------------
		// Rebuilds the chat list from local storage on app initialization.
		if (mode === 'restoreChatsList') {
			const restoredChatsMap = ((await forage({ mode: 'get', what: 'chat', id: brain.user.chatsList.map(chat => chat.id) })) as any[]).reduce((acc, chat) => (acc.set(chat.id, chat), acc), new Map());
			const restoredChats = brain.user.chatsList.map(chat => ({ ...chat, ...(restoredChatsMap.get(chat.id) || {}) }));
			setChats(restoredChats);
			if (notifDots.chats) setTimeout(() => man({ mode: 'getChats', getNewest: true, _chatsOverride: restoredChats }), 0);
			return;
		}

		// CHAT SETUP LOGIC DELEGATION -----------------------------------------
		// Offloads complex creation and modification flows to specialized handler.
		const { mode: followUpMode, handled } = await handleChatSetupLogic({
			mode,
			brain,
			chatObj,
			chatID,
			id,
			setFoundSimilarChats,
			setChatSetupData,
			setCurView,
			run,
			processChatMembers,
			chatType,
			content,
			userObj,
			curView,
			setInformWithTimeout,
			foundSimilarChats,
		});
		if (handled) return;
		else mode = followUpMode;

		// OPTIMISTIC UI TRANSITIONS -------------------------------------------
		// Switches views and manages session state when opening a chat or entering setup.
		if (mode === 'openChat') {
			if (chatSetupData && curView !== 'chatSetup') delete brain.chatSetupData, setChatSetupData(null), setFoundSimilarChats(null);
			if (menuView !== 'chats') setMenuView('chats');
			if (openedChat != chatID) {
				(brain.openedChat = chatID), setOpenedChat(chatID), run('reset'), viewSwitch('openedChat');
				// Auto-scroll to bottom if chat was previously opened
				if (opened) return setTimeout(() => (openedChatRef.current?.scrollTo({ top: openedChatRef.current.scrollHeight }), 0));
			} else return delete brain.openedChat, setOpenedChat(null), (chatObj.current = {});
		}

		let [thisChat, firstID, lastID, [syncMode, cursor]] = [chatObj.current, null, null, cursors === 'gotAll' ? [] : cursors || []];
		const target = mode === 'getArchivedChats' ? 'archive' : mode === 'getInactiveChats' ? 'inactive' : mode === 'getHiddenChats' ? 'hidden' : 'chats';
		if (target === 'archive' && targetChats.length > 0 && notifDots.archive) getNewest = true;

		// CURSOR AND BORDER IDS LOGIC -----------------------------------------
		// Calculates pagination offsets and sync markers for message fetching.
		if (getNewest) cursor = targetChats.length > 0 ? targetChats[0]?.messages?.slice(-1)[0]?.id : cursor;
		else if (mode === 'getChats' || mode === 'getHiddenChats') cursor = targetChats.length > 0 ? targetChats.slice(-1)[0]?.messages?.slice(-1)[0]?.id : cursor;
		else if (['getArchivedChats', 'getInactiveChats'].includes(mode)) cursor = targetChats.length > 0 ? targetChats.slice(-1)[0]?.last : cursor;
		else if (mode === 'getMessages' || mode === 'openChat' || mode === 'reenterChat') {
			// Find first ID for new messages (messages older than 15 minutes)
			if (syncMode === 'new' && messages && cursor) {
				const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
				const lastIndex = messages.findLastIndex(m => m.id >= cursor && !m.refetch && new Date(m.created).getTime() > fifteenMinutesAgo);
				firstID = lastIndex !== -1 ? messages[lastIndex]?.id : null;
			}
			if (syncMode !== 'old' && messages) lastID = messages[0]?.id;
			if (firstID === lastID) firstID = null;
		}

		// QUICK NAVIGATION HANDLERS -------------------------------------------
		// Handles rapid view switching and state resetting.
		if (mode === 'backToChats')
			return (
				setCurView('chats'),
				(chatObj.current = chats.find(chat => chat.id === brain.openedChat)),
				delete brain.chatSetupData,
				setChatSetupData(null),
				setModes(prev => ({ ...prev, menu: false, chatsMenu: false })),
				setOpenedChat(brain.openedChat),
				viewSwitch('chatsList')
			);
		// NAVIGATION AND FETCH GUARDS -----------------------------------------
		// Prevents redundant API calls for categories already loaded or in cooldown.
		if (['getChats', 'getArchivedChats', 'getInactiveChats', 'getHiddenChats'].includes(mode) && !chatID) {
			const alreadyFetched = brain.user.noMore.chats[target] || didFetchChats.current[target];
			const now = Date.now();
			const cooldownMs = 10000;
			const inCooldown = now - lastFetchTime.current[target] < cooldownMs;

			if (alreadyFetched || inCooldown) {
				// Switch view immediately if data is already available in memory
				if (curView !== target && curView !== 'chatSetup' && targetChats.length > 0)
					return delete brain.openedChat, (chatObj.current = {}), setOpenedChat(null), setCurView(target), setTimeout(() => run('reset'), 0);

				// Handle empty state notifications for each category
				if (targetChats.length === 0 && alreadyFetched) {
					const label = `empty${target.replace(/^\w/, c => c.toUpperCase())}`;
					setInform(prev => [...(Array.isArray(prev) ? prev : []), label]), clearTimeout(hideChatsMenuTimeout.current);
					return (hideChatsMenuTimeout.current = setTimeout(() => setInform(prev => (Array.isArray(prev) ? prev.filter(w => !w.startsWith('empty')) : [])), 2000));
				}
				if (alreadyFetched || inCooldown) return;
			}
			lastFetchTime.current[target] = now;
		}

		// MEMBER MODAL TOGGLE -------------------------------------------------
		if (mode === 'getMembers') return setModes(prev => ({ ...prev, members: !prev.members })), viewSwitch();

		// LOCAL CHAT REVIVAL --------------------------------------------------
		// Scans existing chats to reuse private threads or suggest similar group rooms.
		if (mode === 'createChat') {
			if (!foundSimilarChats) {
				const similarLocalChats = [];
				for (const chat of chats) {
					const sameMembers = data.members.every(member => chat.members.some(chatMember => chatMember.id === member.id && chatMember.flag === 'ok'));
					const sameMembersCount = data.members.length === chat.members.length;
					if (sameMembers && sameMembersCount) {
						// AUTO-REUSE PRIVATE CHATS ---------------------------
						if (chat.type === 'private' && data.type === chat.type) {
							(chatID = chat.id), (chatObj.current = thisChat = chat);
							mode = chat.opened ? 'postMessage' : 'openChat';
							break;
						} else similarLocalChats.push(chat);
					}
				}
				if (similarLocalChats.length > 0 && chatSetupData.type !== 'private') return setFoundSimilarChats(similarLocalChats);
			} else if (foundSimilarChats && selSimilarChatID) {
				const similarChat = (chatObj.current = foundSimilarChats.find(chat => chat.id === selSimilarChatID));
				run('unshift', similarChat), (mode = similarChat.opened ? 'postMessage' : 'openChat');
			}
		}

		console.log('chatObj.current', chatObj.current, mode);
		let axiosPayload = {};

		// OPTIMISTIC UPDATES LOGIC --------------------------------------------
		// Provides instant visual feedback for message operations with rollback safety.
		let optimisticRollback = null;
		let tempMessID = null;

		if (['postMessage', 'editMessage', 'deleteMessage'].includes(mode) && thisChat) {
			// SNAPSHOT FOR ROLLBACK ---------------------------
			const prevMessages = [...(thisChat.messages || [])];
			optimisticRollback = () => {
				thisChat.messages = prevMessages;
				run('refreshChatIdx', thisChat);
				run('store', thisChat);
			};

			// EXECUTE OPTIMISTIC ACTION ---------------------------
			if (mode === 'postMessage') {
				tempMessID = Date.now() + Math.random(); // Temp ID for tracking ---------------------------
				const newMessage = {
					user: brain.user.id,
					content: content ?? data?.content,
					created: Date.now(),
					id: tempMessID,
					attach,
					own: true,
					optimistic: true,
				};
				thisChat.messages = [...prevMessages, newMessage];
				run('unshift', thisChat);
				setTimeout(() => bottomScroll.current?.scrollIntoView({ behavior: 'smooth' }), 50);
			} else if (mode === 'editMessage' && messID) {
				const msgIndex = thisChat.messages.findIndex(m => m.id === messID);
				if (msgIndex !== -1) {
					const updatedMsg = { ...thisChat.messages[msgIndex], content: content, attach };
					thisChat.messages[msgIndex] = updatedMsg;
					setChats(prev => [...prev]); // Trigger re-render of list ---------------------------
				}
			} else if (mode === 'deleteMessage' && messID) {
				thisChat.messages = thisChat.messages.filter(m => m.id !== messID);
				setChats(prev => [...prev]);
			}
		}

		// SERVER COMMUNICATION PREPARATION ------------------------------------
		// Gathers required metadata for both Socket.io and Axios requests.
		try {
			const messageModes = ['postMessage', 'editMessage', 'deleteMessage'];
			const punishmentModes = ['kick', 'ban', 'gag', 'unban', 'ungag'];
			const blockChatModes = ['blockChat', 'unblockChat'];
			const useSocket = [...messageModes, ...punishmentModes, 'messSeen', ...blockChatModes].includes(mode);

			Object.assign(
				axiosPayload,
				delUndef({
					...((['createChat', 'setupChat'].includes(mode) && brain.chatSetupData) || {}),
					chatID: selSimilarChatID || chatID || thisChat.id,
					...(mode === 'createChat' && foundSimilarChats && !selSimilarChatID && { similarChatsDenied: true }),
					...((content || data?.content) &&
						(messageModes.includes(mode) || mode === 'openChat') && { message: { ...(messID && { id: messID }), content: content || data?.content, attach } }),
					...(mode === 'getMessages' && { syncMode, cursor, firstID, lastID }),
					...(getNewest && { getNewest: true }),
					...(['messSeen', 'deleteMessage'].includes(mode) && { messID }),
					...(['openChat', 'reenterChat'].includes(mode)
						? {
								membSync,
								seenSync,
								cursor,
								firstID,
								...(lastID !== cursor && { lastID }),
								...(mode === 'openChat' && punish && !who && { getPunInfo: true }),
						  }
						: {}),
					...(blockChatModes.includes(mode) && { targetUserID }),
					...(punishmentModes.includes(mode) && { targetUserID, until, mess: content, chatID }),
				})
			);

			console.log('axiosPayload', axiosPayload);

			// REAL-TIME TRANSMISSION ----------------------------------------------
			// Attempts to use Socket.io for interactive updates with Axios fallback.
			let fallbackToAxios;
			if (useSocket) {
				try {
					const shouldJoinRoom = mode === 'postMessage' && !thisChat.joinedRoom;
					response = await socket({ mode, ...axiosPayload, ...(shouldJoinRoom && { joinRoom: true }) });
					console.log('🚀 ~ SOCKET CHAT RESPONSE ------------------------------', response);
				} catch (error) {
					if (['fallbackToAxios', 'emitTimeout:message', 'timeout'].some(m => error.message?.includes(m))) fallbackToAxios = true;
					else throw error;
				}
			}

			// HTTP FALLBACK / ADMINISTRATIVE CALLS --------------------------------
			// Used for data-heavy syncing or when real-time connection is unavailable.
			if (!useSocket || fallbackToAxios) {
				response = (await axios.post('chat', { mode, ...axiosPayload })).data || {};
				console.log('AXIOS CHAT RESPONSE ------------------------------', response);
			}

			// CONFIRM OPTIMISTIC UPDATES ------------------------------------------
			// Replaces temporary IDs with server-generated ones to stabilize the local state.
			if (optimisticRollback) {
				if (mode === 'postMessage' && response.messID && thisChat) {
					const msg = thisChat.messages.find(m => m.id === tempMessID);
					if (msg) {
						msg.id = Number(response.messID);
						delete msg.optimistic;
						setChats(prev => [...prev]);
					}
				}
			}

			const {
				chats: resChats = [],
				messages: resMessages = [],
				members: resMembers = [],
				membSync: resMembSync,
				seenUpdates,
				seenSync: resSeenSync,
				punInfo,
				chatID: newChatID,
				messID: newMessID,
				newType,
				similarChats,
				didJoinRoom,
			} = response;

			if (didJoinRoom && thisChat) thisChat.joinedRoom = true;

			// NEW CHAT CREATION ---------------------------------------------------
			// Converts a temporary setup object into a fully functional chat room.
			if (mode === 'createChat' && !similarChats) {
				(mode = 'postMessage'), brain.user.noMore.messInChats.push(newChatID);
				const newChat = {
					...chatSetupData,
					id: Number(newChatID),
					membSync: resMembSync,
					seenSync: resSeenSync,
					cursors: 'gotAll',
					muted: false,
					seen: true,
					flag: 'ok',
					messages: [],
					joinedRoom: !!didJoinRoom,
				};
				thisChat = chatObj.current = newChat;
				// Post initial message into the newly created chat ---------------------------
				if (content) {
					const newMsg = { user: brain.user.id, content: content, created: Date.now(), id: Number(newMessID), attach, own: true };
					thisChat.messages.push(newMsg);
					run('unshift', thisChat);
				}
			}

			// ROOM CONFIGURATION UPDATES ---------------------------
			if (mode === 'setupChat') return Object.assign(thisChat, data), setCurView('chats'), delete brain.chatSetupData, setChatSetupData(null), run('refreshChatIdx', thisChat);
			if (mode === 'endChat') run('refreshChatIdx', Object.assign(thisChat, { ended: true }, { members: thisChat.members.map(member => ({ ...member, role: 'spect' })) }));
			if (newType) {
				thisChat.type = newType;
				for (const member of thisChat.members) {
					if (newType === 'free' && member.role !== 'spect') member.role = 'member';
					else if (newType === 'group' && member.role === 'VIP') member.role = 'admin';
				}
			}

			// QUICK CHAT ACTIONS HANDLER ------------------------------------------
			// Processes lightweight commands like muting, archiving, or pinning.
			const quickActionsProps = { brain, thisChat, targetUserID, messages, messID, content, attach, run };
			const quickActionsHandlers = { openedChat, chatID, setOpenedChat, chatObj, chats, setCurView, curView, getMembersObj };
			const quickActions = createQuickActions({ ...quickActionsProps, ...quickActionsHandlers });
			const finishQuickAction = () => (run('reset'), run('refreshChatIdx', thisChat), run('store'), setScrollDir('down'));
			if (quickActions[mode]) return await quickActions[mode](), finishQuickAction();

			// CHAT LIST SYNCHRONIZATION -------------------------------------------
			// Merges incoming chat meta-data with local storage and updates categories.
			const chatsArray = similarChats ? [] : [...(inp._chatsOverride || chats)];
			if (mode === 'getChats' || mode === 'getArchivedChats' || mode === 'getInactiveChats' || mode === 'getHiddenChats' || similarChats) {
				for (const chat of resChats?.length > 0 ? resChats : similarChats || []) {
					const { created, user, content, seenId, attach, lastMessID, role, chatMember: incomingChatMember, punish, until, who, flag, ...rest } = chat;
					const [membId, membFirst, membLast, membVImg, membSeenId] = incomingChatMember ? incomingChatMember.split(':') : [];
					const applyChatLevelPropsToMeMember = memberObj => Object.assign(memberObj, { role: rest.type === 'private' ? 'member' : role, punish, until, who, seenId, flag });

					const chatInMemory = chatsArray.find(c => String(c.id) === String(chat.id));
					const existing = chatInMemory || (await forage({ mode: 'get', what: 'chat', id: chat.id }));

					if (!chatInMemory && existing) chatsArray.push(existing);

					const fullMemberObj = { id: membId, first: membFirst, last: membLast, imgVers: membVImg, seenId: membSeenId };
					if (String(membId) === String(brain.user.id)) applyChatLevelPropsToMeMember(fullMemberObj);

					// AUTO-FETCH OWN PROFILE IF MISSING ---------------------------
					if (!brain.user.first) {
						if (String(membId) === String(brain.user.id)) Object.assign(brain.user, { first: membFirst, last: membLast, imgVers: membVImg });
						else await fetchOwnProfile(brain);
					}

					const messageObj = {
						id: Number(lastMessID),
						created: new Date(created).getTime(),
						user: user,
						attach,
						content,
						own: user?.toString() == brain.user.id,
						...((mode === 'getChats' || mode === 'getHiddenChats' || mode === 'getArchivedChats' || mode === 'getInactiveChats') &&
							(content?.length === 100 || attach) && { refetch: true }),
					};

					// SYNC WITH EXISTING CHAT OBJECT ---------------------------
					if (!existing) {
						const meMemberObj = String(membId) !== String(brain.user.id) ? createSubsetObj(brain.user, ['id', 'first', 'last', 'imgVers']) : null;
						if (meMemberObj) applyChatLevelPropsToMeMember(meMemberObj);
						chatsArray.push({
							...rest,
							role: role === 'priv' ? 'member' : role,
							seen: String(user) === String(brain.user.id) || Number(seenId) >= Number(lastMessID),
							cursors: messageObj.refetch ? ['new', 0, 0] : ['new', lastMessID, lastMessID],
							members: [...(meMemberObj ? [meMemberObj] : []), fullMemberObj],
							messages: [messageObj],
						});
					} else {
						Object.assign(existing, chat);
						const targetMember = existing.members.find(member => member.id == fullMemberObj.id);
						if (String(targetMember?.id) === String(brain.user.id)) applyChatLevelPropsToMeMember(targetMember);
						Object.assign(targetMember, fullMemberObj);

						const hasNewMessages = existing.messages.slice(-1)[0]?.id < messageObj.id;
						if (hasNewMessages) {
							existing.messages.push(messageObj), (existing.cursors = ['new', messageObj.refetch ? 0 : messageObj.id, existing.cursors[2]]);
							const meMember = existing.members.find(member => member.id === brain.user.id);
							existing.seen = messageObj.id <= meMember.seenId || String(messageObj.user) === String(brain.user.id);
						}
					}
				}

				// UPDATE STATE AND CACHE ---------------------------
				if (similarChats) {
					if (chatSetupData.type === 'private') {
						(thisChat = chatObj.current = chatsArray.find(chat => chat.id == similarChats[0].id)), (mode = 'postMessage');
					} else return setFoundSimilarChats(chatsArray);
				} else if (['getChats', 'getArchivedChats', 'getInactiveChats', 'getHiddenChats'].includes(mode)) {
					if (!getNewest && !chatID) brain.user.noMore.chats[target] = (resChats?.length || 0) < 20 ? Date.now() : 0;
					if (!chatID && menuView === 'chats') didFetchChats.current[target] = true; // MARK AS FETCHED ---------------------------
					if (target === 'archive') setNotifDots(prev => ({ ...prev, archive: 0 }));

					const sortedChats = chatsArray.sort((a, b) => b.messages?.slice(-1)[0]?.id - a.messages?.slice(-1)[0]?.id);

					// FILTER BY TARGET VIEW ---------------------------
					const targetFilter = c => {
						const myFlag = c.members?.find(m => String(m.id) === String(brain.user.id))?.flag;
						return target === 'chats' ? myFlag === 'ok' && !c.archived && !c.hidden : target === 'archive' ? c.archived : target === 'hidden' ? c.hidden : myFlag === 'del';
					};
					const actualTargetCount = sortedChats.filter(targetFilter).length;

					if (actualTargetCount === 0) {
						// SHOW EMPTY NOTIFICATION ---------------------------
						setInform(prev => [
							...(Array.isArray(prev) ? prev : []),
							target === 'chats' ? 'emptyChats' : target === 'archive' ? 'emptyArchive' : target === 'hidden' ? 'emptyHidden' : 'emptyInactive',
						]);
						clearTimeout(hideChatsMenuTimeout.current);
						hideChatsMenuTimeout.current = setTimeout(() => setInform(prev => (Array.isArray(prev) ? prev.filter(w => !w.startsWith('empty')) : [])), 2000);
						return setChats(sortedChats);
					}

					// FINALIZE CHAT LIST STATE ---------------------------
					setInform(prev => (Array.isArray(prev) ? prev.filter(w => !w.startsWith('empty')) : []));
					curView !== target && curView !== 'chatSetup' && (setCurView(target), setTimeout(() => run('reset'), 0));
					const chatsList = mode === 'getChats' && !chatID ? sortedChats.map(chat => ({ ...chat, messages: chat.messages.slice(chat.messages.length - 1) })) : null;
					if (chatsList) (brain.user.chatsList = chatsList), await forage({ mode: 'set', what: 'user', val: brain.user });
					return setChats(sortedChats);
				}
			}

			// CHAT RE-ENTRY -------------------------------------------------------
			// Restores full membership status after a gag or temporary leave.
			if (mode === 'reenterChat') {
				const meMember = thisChat.members?.find(member => String(member.id) === String(brain.user.id));
				if (meMember) {
					// Clear punishment markers and restore active roles ---------------------------
					['punish', 'until', 'mess', 'who'].forEach(key => delete meMember[key]);
					meMember.role = 'member';
					meMember.flag = 'ok';
				}
				thisChat.joinedRoom = true;
				run('store', thisChat);
				run('refreshChatIdx', thisChat);
				return setChats(prev => [...prev]);
			}

			// MESSAGE AND MEMBER SYNC ---------------------------------------------
			// Processes incoming message batches, deduplicates entries, and fetches missing member data.
			if (mode === 'openChat' || resMessages.length > 0) {
				cursor = resMessages.slice(-1)[0]?.id || cursor;

				// PAGINATION CURSOR UPDATE ---------------------------
				if (resMessages.length === 20) syncMode = (!lastID && !firstID) || syncMode === 'old' ? syncMode : lastID && cursor <= lastID ? 'old' : firstID && cursor <= firstID ? 'del' : syncMode;
				else cursor = 'gotAll';

				const [missingMembersIDs, newMessages] = [new Set(), []];
				const curMessagesMap = new Map((thisChat.messages || []).map(mess => [Number(mess.id), mess]));
				const curMembersIDsSet = new Set((thisChat.members || []).map(member => member.id));

				// DEDUPLICATE AND NORMALIZE MESSAGES ---------------------------
				for (const message of resMessages) {
					const existingMsg = curMessagesMap.get(Number(message.id)) as any;
					if (existingMsg) delete existingMsg.refetch, Object.assign(existingMsg, { ...message, id: Number(message.id), user: message.user, created: new Date(message.created).getTime() });
					else
						newMessages.push(
							Object.assign(message, {
								id: Number(message.id),
								user: message.user,
								created: new Date(message.created).getTime(),
								own: String(message.user) === String(brain.user.id),
							})
						);
				}

				// MERGE AND SORT COMPLETE THREAD ---------------------------
				const [merged, seenIds, deduped] = [[...newMessages, ...(thisChat.messages || [])], new Set(), []];
				for (const msg of merged) {
					const authorId = msg.user;
					if (!seenIds.has(msg.id)) seenIds.add(msg.id), deduped.push(msg);
					if (!curMembersIDsSet.has(authorId)) missingMembersIDs.add(authorId);
				}

				(thisChat.messages = deduped.sort((a, b) => a.id - b.id)), (thisChat.opened = true);
				Object.assign(thisChat, {
					seen: true,
					opened: true,
					cursors: cursor === 'gotAll' ? cursor : [syncMode, cursor],
					membSync: resMembSync || thisChat.membSync,
					seenSync: resSeenSync || thisChat.seenSync,
				});

				// FETCH UNKNOWN AUTHORS -----------------------------------------------
				// Ensures every message has associated user data for correct avatar rendering.
				if (missingMembersIDs.size) {
					try {
						const candidateIds = Array.from(missingMembersIDs).filter(id => id != brain.user.id);
						const requestIds = candidateIds.filter(id => !curMembersIDsSet.has(id));

						if (requestIds.length) {
							const { data } = await axios.post('chat', { mode: 'getMembers', chatID: thisChat.id, memberIDs: requestIds });
							resMembers.push(...(data?.members || []));
						}
					} catch (e) {
						console.error('Failed to fetch missing members:', e);
						notifyGlobalError(e, 'Nepodařilo se načíst členy chatu.');
					}
				}

				// APPLY READ-RECEIPT UPDATES ------------------------------------------
				(function applySeenUpdates(chatObj, seenUpdates = []) {
					if (!Array.isArray(seenUpdates) || !seenUpdates.length) return;
					const memberMap = new Map((chatObj?.members || []).map(member => [member.id, member]));
					for (const update of (seenUpdates.filter(Boolean) as any[])) {
						const member = memberMap.get((update as any).id) as any;
						if (member) member.seenId = (update as any).seenId != null ? Number((update as any).seenId) : null;
					}
				})(thisChat, seenUpdates);

				brain.openedChat = thisChat.id;
				if (punInfo) Object.assign(thisChat.members.find(member => member.id == brain.user.id) || {}, punInfo);
				if (newMessID) mode = 'postMessage';
				setTimeout(() => setScrollDir('up'), 200);
			}

			// FINALIZE MEMBER DATA ------------------------------------------------
			if (resMembers?.length || mode === 'openChat') {
				processChatMembers({ chatObj: thisChat, members: resMembers || thisChat.members, membSync: resMembSync });
			}

			// CONFIRM POSTED MESSAGE ---------------------------------------------
			if (mode === 'postMessage') {
				if (!optimisticRollback && newMessID) {
					const updatedChat = { ...thisChat, messages: [...(thisChat.messages || [])] };
					Object.assign(updatedChat, { seen: true, ...(didJoinRoom && { joinedRoom: true }) });

					const lastMessage = updatedChat.messages.slice(-1)[0];
					if (!lastMessage || lastMessage.id < Number(newMessID)) {
						updatedChat.messages.push({ user: brain.user.id, content: content ?? data?.content, created: Date.now(), id: Number(newMessID), attach, own: true });
					}

					thisChat = chatObj.current = updatedChat;
					(brain.openedChat = updatedChat.id), run('unshift', updatedChat), setTimeout(() => bottomScroll.current?.scrollIntoView({ behavior: 'smooth' }), 200);
				}
			}

			// USER PUNISHMENT ADMINISTRATION --------------------------------------
			// Processes kicks, bans, and gags both locally and on the server via socket.
			if (punishmentModes.includes(mode)) {
				const punishType = mode.startsWith('un') ? null : mode;
				const punisherID = brain.user.id;

				const updateMemberPunishment = membersSrc => {
					const targetMember = membersSrc?.find(member => member.id === targetUserID);
					if (targetMember) {
						if (mode.startsWith('un')) {
							delete targetMember.punish, delete targetMember.until, delete targetMember.who, delete targetMember.mess;
							if (targetMember.role === 'spect') targetMember.role = 'member';
						} else {
							Object.assign(targetMember, { punish: punishType, until, who: punisherID, mess: content });
						}
					}
					return targetMember;
				};

				updateMemberPunishment(thisChat.members);
				if (curView === 'chatSetup' && chatSetupData?.members) {
					updateMemberPunishment(chatSetupData.members);
					setChatSetupData(prev => ({ ...prev, members: [...prev.members] }));
				} else run('refresh');

				run('store', thisChat), setScrollDir('down');
				return;
			}

			// FINALIZE CHAT SETUP TRANSITION --------------------------------------
			if (curView === 'chatSetup') {
				delete brain.chatSetupData, (brain.openedChat = thisChat.id);
				setChatSetupData(null), setFoundSimilarChats(null), setCurView('chats'), setOpenedChat(thisChat.id), viewSwitch?.('openedChat');
			}

			run('store', thisChat);
		} catch (err) {
			console.error('Error in chat manager:', err);
			// ROLLBACK OPTIMISTIC STATE ON FAILURE ---------------------------
			if (optimisticRollback) {
				optimisticRollback();
				if (mode === 'postMessage') {
					setInform(prev => [...(Array.isArray(prev) ? prev : []), `restoreDraft:${content}`]);
				}
			}
			notifyGlobalError(err, 'Nepodařilo se dokončit akci v chatu.');
		}
	}

	// COMPONENT LIFECYCLE SYNC --------------------------------------------
	manRef.current = man;
	useLayoutEffect(() => {
		manRef.current = man;
	});

	const commonProps = { scrollDir, setScrollDir, modes, chatObj: chatObj.current, setModes, brain, curView, chatMan: man, inform, setInform, getPunishmentStatus };

	// RENDER CHAT SHELL ---------------------------------------------------
	return (
		<chats-wrapper ref={mainWrapperRef} class={`${!openedChat ? 'bInsetBlueDark' : ''} ${menuView !== 'chats' ? 'hide' : ''} block bgWhite mhvh100 mihvh100 h100 w100 overHidden`}>
			{/* CHAT HOME SCREEN --------------------------------------------------------------- */}
			{curView !== 'chatSetup' && (
				<messaging-view class={' mhvh100 hvh100 bgWhite w100 flexCen wrap'}>
					<ChatsList {...{ chatsListRef, chats, ...commonProps, setCurView, openedChat, notifDots }} />
					<wrap-trigger class='selfStart' ref={wrapTriggerRef} />

					{openedChat && <OpenedChat {...{ openedChat, infinityTrigger, bottomScroll, openedChatRef, ...commonProps, hasPushedState, isWrapped, viewSwitch, getPunishmentStatus }} />}
				</messaging-view>
			)}

			{/* CHAT SETUP DIALOG ------------------------------------------------------------- */}
			{chatSetupData && curView === 'chatSetup' && (
				<Suspense fallback={<div>Loading...</div>}>
					<ChatSetup
						{...{
							chatSetupData,
							setInform,
							foundSimilarChats,
							selSimilarChatID,
							informScroll: informScroll.current,
							setSelOldChatID,
							setChatSetupData,
							setMenuView,
							...commonProps,
						}}
					/>
				</Suspense>
			)}
		</chats-wrapper>
	);
}

// RENDER OPTIMIZATION -------------------------------------------------
function dontRerender(prevProps, nextProps) {
	return prevProps.menuView === nextProps.menuView && prevProps.brain === nextProps.brain && prevProps.notifDots === nextProps.notifDots;
}

export default memo(Chat, dontRerender);
