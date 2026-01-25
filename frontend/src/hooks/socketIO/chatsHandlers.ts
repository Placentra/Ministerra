import axios from 'axios';
import { notifyGlobalError } from '../useErrorsMan';
import { setPropsToContent } from '../../../helpers';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** ----------------------------------------------------------------------------
 * CHATS HANDLERS
 * Processes incoming socket events for chat messages and room updates.
 * Manages message processing, member updates, punishments, and room status.
 * -------------------------------------------------------------------------- */
export function createChatsHandlers({ brain, chatsRef, setChats, setNotifDots, depsRef, showToast, setMenuView, getTargetChat, bottomScroll, setScrollDir }) {
	// PENDING MEMBER FETCH DEDUPE ---------------------------------------------
	// Steps: prevent bursty events from triggering multiple identical “getMembers” calls for the same (chat,user) pair.
	const pendingMemberFetches = new Set();

	// WAIT FOR CHAT TO APPEAR IN CACHE ----------------------------------------
	// Steps: after an async “getChats” request, poll briefly so subsequent handlers can operate on a real chat object instead of failing or duplicating state.
	const waitForChatCache = async ({ chatID, maxWaitMs = 2000 }) => {
		if (!chatID) return null;
		const start = Date.now();
		let cached = getTargetChat(chatID);
		while (!cached && Date.now() - start < maxWaitMs) {
			await sleep(20);
			cached = getTargetChat(chatID);
		}
		return cached;
	};

	async function processMessage(event) {
		// MESSAGE EVENT --------------------------------------------------------
		// Steps: ensure chat exists (fetch if missing), ensure author member data exists, then apply mutation based on mode (new/edit/delete) and trigger UI side-effects (dots/toasts/scroll).
		console.log('PROCESS MESSAGE SOCKET  EVENT', event);
		const { chatID, message, mode } = event;
		const { id: messID, content, attach, user, who } = message || {};
		let chat = getTargetChat(chatID);

		if (!chat) {
			// CHAT HYDRATION ----------------------------------------------------
			// Steps: request chat list containing this chat, then wait briefly for cache update; if still missing, drop event (nothing to apply to).
			await depsRef.man?.({ mode: 'getChats', chatID });
			chat = await waitForChatCache({ chatID });
			if (!chat) return false;
		}

		console.log('🚀 ~ PROCESS MESSAGE CHAT:', chat);

		chat.joinedRoom = true;
		await fetchSingleMemberData(user, chat);
		// Handle each message type
		switch (mode) {
			case 'new': {
				// NEW MESSAGE ---------------------------------------------------
				// Steps: unhide/unarchive indicators, merge message idempotently (avoid dupes), set seen=false for incoming, set notif dots/toast as needed, then persist + reorder chats.
				if (chat.hidden) chat.hidden = false;
				if (chat.archived) setNotifDots(prev => ({ ...prev, archive: 1 }));
				const authorMemberObj = chat.members.find(m => String(m.id) === String(user));
				console.log('🚀 ~ PROCESS MESSAGE AUTHOR MEMBER OBJ:', authorMemberObj);

				if (authorMemberObj?.punish) ['punish', 'until', 'who', 'mess'].forEach(prop => delete authorMemberObj[prop]);
				if (chat.type === 'private') chat.members.forEach(member => (delete member.who, delete member.punish));

				const incomingOwn = String(user) === String(brain.user.id);
				const existingIdx = chat.messages.findIndex(m => String(m.id) === String(messID));
				const isNewMessage = existingIdx === -1;
				console.log('🚀 ~ PROCESS MESSAGE IS NEW MESSAGE:', isNewMessage);

				// IMMUTABLE MESSAGE COPY ---
				// Steps: create a copy of the message object to avoid mutating the original socket event payload.
				if (isNewMessage) chat.messages.push({ ...message, own: incomingOwn });
				else {
					const target = chat.messages[existingIdx];
					Object.assign(target, { ...message, own: incomingOwn });
				}

				if (!incomingOwn) {
					chat.seen = false;
					if (!chat.muted && brain.menuView !== 'chats' && isNewMessage) {
						setNotifDots(prev => ({
							...prev,
							chats: 1,
						}));
					}

					// Show toast unless user is viewing this exact chat
					const isViewingThisChat = brain.menuView === 'chats' && brain.openedChat == chatID;
					console.log('🚀 ~ processMessage ~ brain.menuView:', brain.menuView);

					console.log('🚀 ~ processMessage ~ isViewingThisChat:', isViewingThisChat, brain.openedChat, chatID);

					if (isNewMessage && !isViewingThisChat && !chat.muted) {
						showToast({
							alert: {
								what: 'message',
								target: chatID,
								data: {
									content: message.content,
									attach: message.attach,
									user: chat.members.find(m => String(m.id) === String(user)) || { id: user },
									chatName: chat.type !== 'private' ? chat.name : undefined,
								},
								created: Date.now(),
							},
							brain,
							placement: 'top',
							timeout: 5000,
							onToastClick: () => {
								setMenuView('chats');
								setTimeout(() => depsRef.man?.({ mode: 'openChat', chatID }), 100);
							},
						});
					}

					// Highlight the chat strip and scroll to top if in chats view but different chat
					if (isNewMessage && brain.menuView === 'chats' && brain.openedChat !== chatID) {
						brain.highlightChatId = chatID;
						setTimeout(() => {
							brain.highlightChatId = null;
						}, 3500);
					}
				}

				(depsRef.run('store', chat), depsRef.run('refreshChatIdx', chat), depsRef.run('unshift', chat));

				// Auto-scroll if user is viewing this chat
				if (brain.menuView === 'chats' && brain.openedChat === chatID && bottomScroll?.current) {
					requestAnimationFrame(() => {
						bottomScroll.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
					});
				}

				return true;
			}

			case 'edi':
			case 'del': {
				// EDIT/DELETE ----------------------------------------------------
				// Steps: find target message (by id + optional author), apply patch/delete, then debounce persistence to avoid hammering storage on rapid edits.
				const msg = chat.messages.find(m => String(m.id) === String(messID) && (!user || String(m.user) === String(user)));
				if (!msg) return false;
				const [delProps, editProps] = [
					{ content: null, attach: null, flag: 'del', who },
					{ content: content ?? msg.content, attach: attach ?? msg.attach, edited: Date.now() },
				];
				Object.assign(msg, mode === 'del' ? delProps : editProps);
				// Debounce store operations
				if (brain.chatStoreInProg[chat.id]) {
					clearTimeout(brain.chatStoreInProg[chat.id]);
				}
				brain.chatStoreInProg[chat.id] = setTimeout(() => {
					depsRef.run('store', chat);
					delete brain.chatStoreInProg[chat.id];
				}, 3000);
				depsRef.run('refreshChatIdx', chat);
				return true;
			}

			default:
				console.warn(`Unknown message mode: ${mode}`);
				return false;
		}
	}

	// ROOMS REJOINED -----------------------------------------------------------
	// Steps: after reconnect, mark each chat with joinedRoom flag based on server rejoin result so UI doesn't assume real-time is active when it isn't.
	const handleRoomsRejoinedEvent = async ({ chatIDs = [] } = {}) => {
		try {
			const currentChats = chatsRef.current || [];
			if (!Array.isArray(chatIDs) || chatIDs.length === 0 || !currentChats.length) return;
			for (const chat of currentChats) chat.joinedRoom = chatIDs.includes(chat.id);
			setChats(prev => [...prev]);
		} catch (err) {
			console.error('Error handling roomsRejoined:', err);
			notifyGlobalError(err, 'Nepodařilo se obnovit stav chatovacích místností.');
		}
	};

	// CHAT MEMBERS CHANGED -----------------------------------------------------
	// Steps: forward member deltas into the shared member processor so roles/punishments/flags stay consistent across all views.
	async function handleMembersChangedEvent({ chatID, members = [], allMembers = false, membSync }: any = {}) {
		depsRef.processChatMembers({ chatObj: getTargetChat(chatID), members, allMembers, membSync });
	}

	// CHAT ENDED -----------------------------------------------------------
	// Steps: mark chat ended, strip volatile props, mark room not joined, then demote all members to spect role.
	async function handleChatEndedEvent({ chatID }) {
		const chat = getTargetChat(chatID);
		// PRESERVE TYPE FOR BLOCKING LOGIC ---
		// Steps: keep 'type' so handleBlocking can check targetChat.type !== 'private' after chat ends.
		const basicProps = ['id', 'type', 'members', 'messages', 'cursors', 'seen'];
		if (chat) {
			chat.ended = true;
			chat.joinedRoom = false;
			Object.keys(chat).forEach(prop => !basicProps.includes(prop) && delete chat[prop]);
			// Demote all members to spect role when chat ends
			chat.members?.forEach(m => (m.role = 'spect'));
			depsRef.run('refreshChatIdx', chat);
			depsRef.run('store', chat);
		}
	}

	// FETCH SINGLE MEMBER DATA ----------------------------------------------------------
	// Steps: if member already has basic fields, skip; otherwise fetch minimal member row from backend, then merge into chat members list (or add spect placeholder on miss/error).
	const fetchSingleMemberData = async (id, chat) => {
		if (chat.members.some(m => Number(m.id) === Number(id) && m.first)) return;

		const fetchKey = `${chat.id}:${id}`;
		if (pendingMemberFetches.has(fetchKey)) return;
		else pendingMemberFetches.add(fetchKey);

		try {
			const { data } = await axios.post('/chat', { mode: 'getMembers', chatID: chat.id, memberIDs: [id] });
			if (data?.members?.length) depsRef.processChatMembers({ chatObj: chat, members: data.members });
			else {
				// DUPLICATE CHECK BEFORE PUSH ---
				// Steps: only add placeholder if member doesn't already exist to prevent duplicate entries on retry.
				if (!chat.members.some(m => Number(m.id) === Number(id))) chat.members.push({ id: id, flag: 'del', role: 'spect', sync: Date.now() });
			}
		} catch (error) {
			console.error('Failed to fetch member data:', error);
			// DUPLICATE CHECK BEFORE PUSH ---
			if (!chat.members.some(m => Number(m.id) === Number(id))) chat.members.push({ id: id, flag: 'del', sync: Date.now() });
			notifyGlobalError(error, 'Nepodařilo se načíst informace o členovi chatu.');
		} finally {
			pendingMemberFetches.delete(fetchKey);
		}
	};

	// NEW CHAT -------------------------------------------------
	// Steps: dedupe by ID, toast + dots for incoming chats, mark joined/opened, hydrate member basics into brain, then persist and place chat at top.
	const handleNewChat = async newChatObj => {
		const { id, messages, members } = newChatObj;
		// DUPLICATE CHECK ---
		// Steps: skip if chat already exists to prevent duplicate entries on reconnect/retry.
		if (chatsRef.current?.some(c => Number(c.id) === Number(id))) return;
		const lastMessage = messages[messages.length - 1];
		if (String(lastMessage.user) !== String(brain.user.id)) {
			const author = members.find(m => String(m.id) === String(lastMessage.user)) || { id: lastMessage.user };
			const alert = {
				what: 'newChat',
				target: id,
				data: {
					content: lastMessage.content,
					attach: lastMessage.attach,
					user: author,
					chatType: newChatObj.type,
					chatName: newChatObj.type !== 'private' ? newChatObj.name : undefined,
				},
				created: Date.now(),
			};
			showToast({
				alert,
				brain,
				placement: 'top',
				timeout: 7000,
				onToastClick: () => {
					setMenuView('chats');
					setTimeout(() => depsRef.man?.({ mode: 'openChat', chatID: id }), 100);
				},
			});
			if (!newChatObj.muted) setNotifDots(prev => ({ ...prev, chats: 1 }));
		}
		((newChatObj.joinedRoom = true), (newChatObj.opened = true));
		(depsRef.processChatMembers({ chatObj: newChatObj, members }), setPropsToContent('messages', messages, brain));
		(depsRef.run('unshift', newChatObj), depsRef.run('store', newChatObj));
	};

	// CHAT CHANGED ------------------------------------------------------------
	// Steps: merge new chat metadata, process member deltas when provided, normalize roles when type changes, then persist so list order reflects latest state.
	const handleChatChanged = async ({ chatObj }) => {
		const chat = getTargetChat(chatObj.id);
		if (chat) {
			if (chatObj.members?.length) {
				const me = chatObj.members.find(m => String(m.id) === String(brain.user.id));
				if (me && (me.flag === 'del' || me.punish === 'ban')) chat.joinedRoom = false;
				depsRef.processChatMembers({ chatObj: chat, members: chatObj.members || [] });
			} else if (chatObj.type !== chat.type) {
				for (const member of chat.members) {
					if (chatObj.type === 'free' && member.role !== 'spect') member.role = 'member';
					else if (chatObj.type === 'group' && member.role === 'VIP') member.role = 'admin';
				}
			}
			(delete chatObj.members, Object.assign(chat, chatObj), depsRef.run('refreshChatIdx', chat));
			depsRef.run('store', chat || chatObj);
		}
	};

	// TODO will need to handle base spect members differently, because unpunishing would set them to members instead of spects. punishments for spects shouldnt exist. they could be only removed.
	// CHAT PUNISHMENT ----------------------------------------------------------
	// Steps: apply punishment or unpunishment to member row (and mirror into top-level chat props for current user), update joinedRoom on ban/unban, then persist and refresh chat index for ordering.
	const handleChatPunishment = async ({ chatID, how, who, userID, mess, until, membSync }) => {
		try {
			const targetChat = getTargetChat(chatID);
			if (targetChat) {
				if (membSync) targetChat.membSync = membSync;
				const idx = targetChat.members.findIndex(m => String(m.id) === String(userID));
				if (idx > -1) {
					// Handle un-punishments (unban, ungag) ---------------------------
					if (how && how.startsWith('un')) {
						(delete targetChat.members[idx].punish, delete targetChat.members[idx].until, delete targetChat.members[idx].who, delete targetChat.members[idx].mess);
						if (targetChat.members[idx].role === 'spect') targetChat.members[idx].role = 'member';
					} else {
						Object.assign(targetChat.members[idx], { punish: how, until, who, mess });
					}
					// SYNC TOP-LEVEL PROPS FOR CURRENT USER
					if (String(userID) === String(brain.user.id)) {
						if (how && how.startsWith('un')) {
							['punish', 'until', 'who', 'mess'].forEach(k => delete targetChat[k]);
							// ONLY PROMOTE SPECT TO MEMBER ON UNBAN ---
							if (how === 'unban' && targetChat.role === 'spect') targetChat.role = 'member';
						} else {
							Object.assign(targetChat, { punish: how, until, who, mess });
						}
					}
				}
				// If current user was banned, mark room as left ---------------------------
				const isCurrentUser = String(userID) === String(brain.user.id);
				if (isCurrentUser && how === 'ban') targetChat.joinedRoom = false;
				if (isCurrentUser && how === 'unban') targetChat.joinedRoom = true;

				// EPHEMERAL PUNISHMENT NOTIFICATION (NOT STORED, NOT FOR TARGET USER) ---------------------------
				if (!isCurrentUser) {
					if (!targetChat.punishNotifs) targetChat.punishNotifs = [];
					targetChat.punishNotifs.push({ how, who, userID, mess, until, ts: Date.now() });
					setTimeout(() => {
						if (targetChat.punishNotifs) targetChat.punishNotifs = targetChat.punishNotifs.filter(n => Date.now() - n.ts < 30000);
						setChats(prev => [...prev]);
					}, 30000);
				}

				depsRef.run('refreshChatIdx', targetChat);
				(depsRef.run('store', targetChat), setScrollDir('up'));
				setChats(prev => [...prev]);
			}
		} catch (error) {
			console.error('Error processing punishment:', error);
			notifyGlobalError(error, 'Nepodařilo se aktualizovat omezení v chatu.');
		}
	};

	// PRIVATE CHAT BLOCKING -----------------------------------------------------
	// Steps: ensure chat is present, then apply block/unblock flags to both member rows and top-level chat props so UI can hide/show the thread consistently.
	const handleBlocking = async ({ chatID, who, mode }) => {
		try {
			let targetChat = getTargetChat(chatID);

			if (!targetChat) {
				await depsRef.man?.({ mode: 'getChats', chatID });
				targetChat = await waitForChatCache({ chatID });
			}

			if (!targetChat || targetChat.type !== 'private') return;

			for (const member of targetChat.members || []) {
				if (mode === 'block') {
					targetChat.joinedRoom = false;
					Object.assign(member, { punish: 'block', who });
					// SYNC TOP-LEVEL PROPS
					if (String(member.id) === String(brain.user.id)) Object.assign(targetChat, { punish: 'block', who });
				} else if (mode === 'unblock') {
					delete member.punish;
					delete member.who;
					// SYNC TOP-LEVEL PROPS
					if (String(member.id) === String(brain.user.id)) {
						delete targetChat.punish;
						delete targetChat.who;
					}
				}
			}

			depsRef.run('store', targetChat);
			depsRef.run('refreshChatIdx', targetChat);
		} catch (e) {
			notifyGlobalError(e, 'Nepodařilo se změnit blokování chatu.');
		}
	};

	// MESSAGE SEEN --------------------------------------------------------------
	// Steps: update member.seenId and update chat.seen for current user when last message is covered; then persist so seen markers survive reloads.
	const handleMessageSeen = async ({ chatID, userID, messID }) => {
		try {
			const chat = getTargetChat(chatID);
			if (chat) {
				const member = chat.members.find(m => String(m.id) === String(userID));
				if (member) {
					member.seenId = messID;

					if (String(userID) === String(brain.user.id)) {
						const lastMessID = chat.messages.slice(-1)[0]?.id;
						if (lastMessID && messID >= lastMessID) chat.seen = true;
					}

					depsRef.run('refreshChatIdx', chat);
					depsRef.run('store', chat);
				}
			}
		} catch (error) {
			console.error('Error processing messSeen:', error);
			notifyGlobalError(error, 'Nepodařilo se aktualizovat stav přečtení zpráv.');
		}
	};

	// USER LEFT CHAT --------------------------------------------------------------
	// Steps: handle userLeft event when another user disconnects or leaves the chat room; update their online status in the member list.
	const handleUserLeft = async ({ chatID, userID }) => {
		try {
			const chat = getTargetChat(chatID);
			if (!chat) return;
			const member = chat.members?.find(m => String(m.id) === String(userID));
			if (member) member.online = false;
			setChats(prev => [...prev]);
		} catch (error) {
			console.error('Error handling userLeft:', error);
		}
	};

	// RE-ENTER CHAT -------------------------------------------------------------
	// Steps: clear punishment fields for this member, restore role/flag, then mark joinedRoom for current user so UI allows interaction again.
	const reenterChat = ({ chatID, userID }) => {
		try {
			const chat = getTargetChat(chatID);
			if (!chat) return;

			const memberIdx = chat.members.findIndex(m => String(m.id) === String(userID));
			if (memberIdx > -1) {
				const member = chat.members[memberIdx];
				// Clear punishment fields
				delete member.punish;
				delete member.until;
				delete member.who;
				delete member.mess;
				// Restore role and flag
				member.role = 'member';
				member.flag = 'ok';
			}

			// Mark room as joined if it's the current user
			if (String(userID) === String(brain.user.id)) {
				chat.joinedRoom = true;
			}

			depsRef.run?.('store', chat);
			depsRef.run?.('refreshChatIdx', chat);
			setChats(prev => [...prev]);
		} catch (e) {
			console.error('Error processing reenterChat:', e);
			notifyGlobalError(e, 'Nepodařilo se obnovit přístup do chatu.');
		}
	};

	return {
		processMessage,
		handleRoomsRejoinedEvent,
		handleMembersChangedEvent,
		handleChatEndedEvent,
		handleNewChat,
		handleChatChanged,
		handleChatPunishment,
		handleBlocking,
		handleMessageSeen,
		handleUserLeft,
		reenterChat,
	};
}
