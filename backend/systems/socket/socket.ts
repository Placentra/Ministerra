import { jwtQuickies } from '../../modules/jwtokens.ts';
import { MIN_MODE } from '../../startup/config.ts';
import { Server } from 'socket.io';
import { setupWorker } from '@socket.io/sticky';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import { joinRoom, sendMessage, punishment, messSeen, socketSetter, blocking } from './chatHandlers.ts';
import { socketSetter as entranceSocketSetter } from '../../modules/entrance/index.ts';
import { Redis } from '../systems.ts';
import { getLogger } from '../handlers/loggers.ts';
import { sanitizeSocketPayload } from '../../utilities/sanitize.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';
import { reportSubsystemReady } from '../../cluster/readiness.ts';

const logger = getLogger('Socket.IO');

// CONFIG ---------------------------------------------------------------------
// Steps: build allowed origins list once at startup so handshake checks are cheap and deterministic.
const CORS_ORIGINS = [
	process.env.BACK_END,
	process.env.FRONT_END,
	...(process.env.CORS_ORIGINS?.split(',') || []),
	...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
].filter(Boolean);

const ONLINE_USERS_KEY = REDIS_KEYS.onlineUsers;
const MAX_PAYLOAD_SIZE = 262144;

// Singleton state
let io = null;
let redis = null;
let initialized = false;

const ioRedisSetter = client => (redis = client);

// SOCKET GETTER ---------------------------------------------------------------
// Steps: allow other modules to emit without passing an HTTP server handle.
// LEARNING NOTE: `Socket(server)` is an initializer; callers that only need the live instance should use this getter.
function getSocketIOInstance() {
	return io;
}

// SOCKET SERVER INITIALIZATION -------------------------------------------------
// Steps: initialize singleton io once, wire redis adapter for cross-worker fanout, configure transport/ping for proxy stability,
// then install the connection handler and publish `io` to other modules via setters.
async function Socket(server) {
	if (io) return io;
	if (initialized) return io;

	try {
		// NOTE: If setter hasn't fired yet, fetch client directly (normal during startup)
		if (!redis) redis = await Redis.getClient();

		const pub = redis;
		const sub = await pub.duplicate();

		io = new Server(server, {
			cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'], credentials: true },
			connectionStateRecovery: { maxDisconnectionDuration: 300000 },
			// ADAPTER OPTIONS -------------------------------------------------------
			// LEARNING NOTE: adapter typing lags behind runtime options; keep the option but cast locally.
			adapter: createShardedAdapter(pub, sub, { requestsTimeout: 5000 } as any),
			pingInterval: 25000,
			pingTimeout: 20000,
			transports: ['websocket', 'polling'],
		});

		// CLUSTER SUPPORT ---
		try {
			setupWorker(io);
		} catch (workerErr) {
			logger.info('setupWorker skipped (not in cluster mode or unsupported)', { error: workerErr?.message });
		}

		// CLEANUP STALE DATA ---------------------------------------------------
		// Steps: clear online-users set only in MIN_MODE (single process) so dev/test restarts don't leave stale online markers; cluster mode cannot safely clear shared state.
		if (MIN_MODE) await redis.del(ONLINE_USERS_KEY);
		// NOTE: Removed per-worker "Socket server initialized" log - 20 workers = noise

		io.on('connection', handleConnection);
		io.on('error', err => logger.error('Socket server error', { error: err?.message }));

		socketSetter(io);
		entranceSocketSetter(io);

		initialized = true;
		reportSubsystemReady('SOCKET_IO');
		return io;
	} catch (error) {
		logger.error('Socket init failed', { error: error?.message });
		throw error;
	}
}

// AUTHENTICATE SOCKET ----------------------------------------------------------
// Steps: verify JWT, check session exists in Redis (revocation), enforce device binding (devID + optional print) to prevent token reuse across devices.
async function authenticateSocket(socket) {
	const { token, devID: clientDevID, print: clientPrint } = socket.handshake?.auth || {};

	if (!token) throw new Error('missingToken');

	let decoded;
	try {
		// JWT VERIFY ------------------------------------------------------------
		// LEARNING NOTE: jwtQuickies typing expects extra fields even in verify mode; cast locally to avoid infecting callsites.
		decoded = (jwtQuickies as any)({ mode: 'verify', payload: token });
	} catch (err) {
		logger.alert('Socket auth token verification failed', { error: err?.message });
		throw new Error(err?.message === 'tokenExpired' ? 'needNewAccessToken' : 'unauthorized');
	}

	const { userID, devID, exp } = decoded as any;
	if (!userID || !devID) throw new Error('unauthorized');

	if (clientDevID && clientDevID !== devID) throw new Error('unauthorized');

	const redisKey = `${userID}_${devID}`;
	const storedEntry = await redis.hget(REDIS_KEYS.refreshTokens, redisKey);
	if (!storedEntry) throw new Error('sessionInvalidated');

	// Handle print values that may contain colons (same fix as jwtokens.js) ---------------------------
	const entryStr = String(storedEntry),
		colonIdx = entryStr.indexOf(':'),
		storedPrint = colonIdx >= 0 ? entryStr.slice(colonIdx + 1) : '';

	// Enforce print match if a print is stored for this session
	if (storedPrint && storedPrint !== (clientPrint || '')) {
		throw new Error('unauthorized');
	}

	return {
		userID,
		devID,
		tokenExpiry: exp * 1000,
		devicePrint: storedPrint || clientPrint || null,
		redisKey,
	};
}

// HANDLE CONNECTION ------------------------------------------------------------
// Steps: authenticate, attach identity, mark user online, join personal room, install middleware+handlers, install disconnect hooks,
// then rejoin active chat rooms to resume real-time updates after reconnect.
async function handleConnection(socket) {
	try {
		// 1. Authenticate
		const auth = await authenticateSocket(socket);
		socket.userID = auth.userID;
		socket.devID = auth.devID;
		socket.tokenExpiry = auth.tokenExpiry;
		socket.devicePrint = auth.devicePrint;
		socket.redisKey = auth.redisKey;

		// 2. Mark user online and join personal room
		await redis.sadd(ONLINE_USERS_KEY, auth.userID);
		logger.info('User marked online', { userID: auth.userID });
		await socket.join(String(auth.userID));

		// 3. Setup middleware and handlers
		installMiddleware(socket);
		setupEventHandlers(socket);

		// 4. Setup disconnect handlers
		socket.on('disconnecting', () => handleDisconnecting(socket));
		socket.on('disconnect', () => handleDisconnect(socket));

		// 5. Rejoin active chat rooms
		await rejoinChatRooms(socket);

		logger.info('Socket connected', { userID: auth.userID, socketId: socket.id });
	} catch (error) {
		const msg = error?.message || 'unauthorized';
		logger.alert('Socket auth failed', { error: msg, socketId: socket.id });
		socket.emit('error', msg);
		socket.disconnect(true);
	}
}

// INSTALL MIDDLEWARE -----------------------------------------------------------
// Steps: block expired access tokens (except refreshAuth), enforce payload size cap, sanitize payload shape, then attach userID before handlers run.
function installMiddleware(socket) {
	socket.use(async ([event, data, ack], next) => {
		try {
			if (event !== 'refreshAuth') {
				if (socket.tokenExpiry && Date.now() > socket.tokenExpiry) {
					socket.emit('error', 'needNewAccessToken');
					return typeof ack === 'function' ? ack({ error: 'needNewAccessToken' }) : next(new Error('needNewAccessToken'));
				}
			}

			if (data) {
				try {
					const size = typeof data === 'string' ? data.length : JSON.stringify(data).length;
					if (size > MAX_PAYLOAD_SIZE) {
						return typeof ack === 'function' ? ack({ error: 'payloadTooLarge' }) : next(new Error('payloadTooLarge'));
					}
				} catch {}
			}

			if (data && event !== 'refreshAuth' && typeof sanitizeSocketPayload === 'function') {
				try {
					const sanitized = sanitizeSocketPayload(data);
					if (sanitized === null) return next(new Error('invalidPayload'));
					// Clear original keys and apply only sanitized keys to prevent malicious key persistence
					for (const key of Object.keys(data)) delete data[key];
					Object.assign(data, sanitized);
					data.userID = socket.userID;
				} catch (err) {
					logger.error('Socket middleware error', { error: err?.message, socketId: socket.id });
					return next(new Error('middlewareError'));
				}
			}

			next();
		} catch (error) {
			next(error);
		}
	});
}

// SETUP EVENT HANDLERS --------------------------------------------------------
// Steps: register chat/membership/moderation handlers, then install refreshAuth handler to update tokenExpiry without reconnecting.
function setupEventHandlers(socket) {
	socket.on('message', (data, cb) => sendMessage(socket, data, cb));
	socket.on('joinRoom', (data, cb) =>
		joinRoom({ socket, userID: socket.userID, ...data, callback: cb }).catch(err => {
			logger.error('joinRoom failed', { error: err?.message, userID: socket.userID, ...data });
			cb?.({ error: err?.message || 'joinRoom failed' });
		})
	);
	socket.on('punishment', (data, cb) => punishment(socket, data, cb));
	socket.on('messSeen', (data, cb) => messSeen(socket, data, cb));
	socket.on('blocking', (data, cb) => blocking(socket, data, cb));

	socket.on('refreshAuth', async ({ token, expiresAt }: any = {}, cb) => {
		try {
			if (!token) return cb?.({ error: 'unauthorized' });

			const decoded = (jwtQuickies as any)({ mode: 'verify', payload: token });
			const { userID, devID, exp } = decoded as any;

			if (userID !== socket.userID || devID !== socket.devID) return cb?.({ error: 'unauthorized' });

			const sessionExists = await redis.hexists(REDIS_KEYS.refreshTokens, socket.redisKey);
			if (!sessionExists) {
				socket.emit('error', 'sessionInvalidated');
				return cb?.({ error: 'sessionInvalidated' });
			}

			socket.tokenExpiry = expiresAt ? Math.min(Number(expiresAt), exp * 1000) : exp * 1000;
			cb?.({ ok: true });
		} catch {
			cb?.({ error: 'needNewAccessToken' });
		}
	});
}

// HANDLE DISCONNECTING --------------------------------------------------------
// Steps: snapshot rooms before Socket.IO clears them, detect whether this is the user’s last socket, then mark left-users per chat room and emit userLeft.
async function handleDisconnecting(socket) {
	const { userID } = socket;
	if (!userID) return;

	// Capture rooms before they're cleared
	socket._capturedRooms = [...socket.rooms];

	try {
		const userSockets = await io.in(String(userID)).allSockets();
		const isLastSocket = userSockets.size <= 1;

		if (isLastSocket) {
			// Mark user as left in each chat room
			for (const room of socket.rooms) {
				if (room.startsWith('chat_')) {
					const chatID = room.split('_')[1];
					await redis.sadd(`${REDIS_KEYS.chatLeftUsers}:${chatID}`, userID);
					socket.to(room).emit('userLeft', { chatID, userID });
				}
			}
		}
	} catch (error) {
		logger.error('handleDisconnecting error', { error: error?.message, userID });
	}
}

// HANDLE DISCONNECT -----------------------------------------------------------
// Steps: if user has no remaining sockets, remove them from online set, then check captured chat rooms and schedule cleanup when a room becomes empty.
async function handleDisconnect(socket) {
	const { userID } = socket;
	if (!userID) return;

	try {
		// Check if user has any remaining sockets
		const userSockets = await io.in(String(userID)).allSockets();

		if (userSockets.size === 0) {
			// No more sockets - remove from online immediately
			// If user reconnects quickly (connection state recovery), they'll be re-added
			// Any alerts during this gap go to userSummary and user fetches via HTTP
			await redis.srem(ONLINE_USERS_KEY, userID);
			logger.info('User went offline', { userID });
		}

		// Clean up empty chat rooms
		const capturedRooms = socket._capturedRooms || [];
		for (const room of capturedRooms) {
			if (!room.startsWith('chat_')) continue;
			const chatID = room.split('_')[1];

			try {
				const socketsInRoom = await io.in(room).allSockets();
				if (socketsInRoom.size === 0) {
					await cleanupEmptyChat(chatID);
				}
			} catch (err) {
				logger.alert('Chat cleanup check failed', { chatID, error: err?.message });
			}
		}

		delete socket._capturedRooms;
	} catch (error) {
		logger.error('handleDisconnect error', { error: error?.message, userID });
	}
}

// CHAT CLEANUP ----------------------------------------------------------------
// Steps: wait for a short grace window, re-check room emptiness, then remove per-chat Redis keys (active sets + left-users) so state does not accumulate.
const CLEANUP_DELAY_MS = 5000; // 5 seconds grace period for reconnection

async function cleanupEmptyChat(chatID) {
	try {
		// Wait briefly to allow for connection state recovery (user may reconnect quickly)
		await new Promise(resolve => setTimeout(resolve, CLEANUP_DELAY_MS));

		// Re-check if room is still empty after delay (user may have reconnected)
		const socketsInRoom = await io.in(`chat_${chatID}`).allSockets();
		if (socketsInRoom.size > 0) {
			logger.info('Chat cleanup skipped - users reconnected', { chatID, socketCount: socketsInRoom.size });
			return;
		}

		const members = await redis.smembers(`${REDIS_KEYS.chatMembers}:${chatID}`);
		// Check for null/undefined/empty array - smembers returns [] for missing key
		if (!members || !Array.isArray(members) || members.length === 0) {
			// Still clean up left_users even if no members
			await redis.del(`${REDIS_KEYS.chatLeftUsers}:${chatID}`);
			return;
		}

		const pipe = redis.multi();
		for (const memberID of members) {
			pipe.srem(`userActiveChats:${memberID}`, chatID);
		}
		pipe.del(`${REDIS_KEYS.chatLeftUsers}:${chatID}`);
		await pipe.exec();

		logger.info('Cleaned up empty chat', { chatID, memberCount: members.length });
	} catch (error) {
		logger.error('cleanupEmptyChat error', { error: error?.message, chatID });
	}
}

// REJOIN CHAT ROOMS -----------------------------------------------------------
// Steps: read userActiveChats set, join those rooms, clear left-users membership entries, then clear summary dot only after successful rejoin.
async function rejoinChatRooms(socket) {
	const { userID } = socket;

	try {
		const activeChats = await redis.smembers(`userActiveChats:${userID}`);
		if (!activeChats?.length) {
			// No active chats, safe to clear notification
			await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'chats', 0);
			return;
		}

		const joinPromises = [];
		const cleanupPipe = redis.pipeline();

		const joined = [];
		let needsCleanup = false;
		for (const chatID of activeChats) {
			joinPromises.push(socket.join(`chat_${chatID}`));
			// Clean up "left users" flag since they are now back online in the room
			cleanupPipe.srem(`${REDIS_KEYS.chatLeftUsers}:${chatID}`, userID);
			needsCleanup = true;
			joined.push(Number(chatID));
		}

		await Promise.all(joinPromises);
		if (needsCleanup) await cleanupPipe.exec();

		if (joined.length) {
			socket.emit('roomsRejoined', { chatIDs: joined });
			// Clear chats notification dot only after successful rejoin
			await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'chats', 0);
		}
	} catch (error) {
		logger.error('rejoinChatRooms error', { error: error?.message, userID });
	}
}

// EMIT TO USERS ---------------------------------------------------------------
// Steps: emit to recipient if online, otherwise set summary alert flag; then emit mirror payload to sender’s other devices for cross-device consistency.
async function emitToUsers({ mode, userID, otherUserID, miniProfiles = {}, message = null, note = null }) {
	try {
		if (!io) {
			logger.alert('emitToUsers: Socket not initialized');
			await redis.hset(`${REDIS_KEYS.userSummary}:${otherUserID}`, 'alerts', 1);
			return;
		}

		const otherUserIsOnline = await redis.sismember(ONLINE_USERS_KEY, otherUserID);
		let emitSuccess = false;

		if (otherUserIsOnline) {
			// PAYLOAD SHAPE --------------------------------------------------------
			// LEARNING NOTE: TS infers `{ dir, target }` as a fixed shape; adding `.data` later errors.
			// Use `any` at this boundary because Socket.IO payloads are runtime-validated elsewhere.
			const payloadIn: any = { dir: 'in', target: userID };
			if (miniProfiles[userID]) payloadIn.data = { ...miniProfiles[userID], ...(message && { message }) };
			io.to(String(otherUserID)).emit(mode, payloadIn);
			emitSuccess = true;
		}

		if (!emitSuccess) {
			await redis.hset(`${REDIS_KEYS.userSummary}:${otherUserID}`, 'alerts', 1);
		}

		// Emit to sender's other devices
		try {
			const senderSockets = await io.in(String(userID)).allSockets();
			if (senderSockets.size > 1) {
				const payloadOut: any = { dir: 'out', target: otherUserID };
				if (miniProfiles[otherUserID]) payloadOut.data = { ...miniProfiles[otherUserID], ...(note && { note }) };
				io.to(String(userID)).emit(mode, payloadOut);
			}
		} catch (error) {
			logger.alert('emitToUsers: failed to emit to sender devices', { error: error?.message, userID });
		}
	} catch (error) {
		logger.error('emitToUsers error', { error: error?.message, mode, userID, otherUserID });
		// Ensure alert flag is set if emit failed unexpectedly
		try {
			await redis.hset(`${REDIS_KEYS.userSummary}:${otherUserID}`, 'alerts', 1);
		} catch (e) {
			logger.error('emitToUsers: failed to set alert flag', { error: e?.message, otherUserID });
		}
	}
}

// GET ONLINE STATUS -----------------------------------------------------------
// Steps: smismember against ONLINE_USERS_KEY, then partition ids into online/offline sets for downstream decisions.
async function getOnlineStatus(userIds) {
	if (!Array.isArray(userIds) || !userIds.length || !redis) {
		return { online: new Set(), offline: new Set() };
	}

	try {
		const online = new Set();
		const offline = new Set();
		const results = await redis.smismember(ONLINE_USERS_KEY, userIds);

		for (let i = 0; i < userIds.length; i++) {
			(results[i] ? online : offline).add(userIds[i]);
		}

		return { online, offline };
	} catch (error) {
		logger.error('getOnlineStatus error', { error: error?.message });
		return { online: new Set(), offline: new Set(userIds) };
	}
}

export { Socket, emitToUsers, ioRedisSetter, getOnlineStatus, getSocketIOInstance };
