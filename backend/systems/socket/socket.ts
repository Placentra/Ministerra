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
import { Redis as ioRedisType } from 'ioredis';

const logger = getLogger('Socket.IO');

// CONFIG ---------------------------------------------------------------------
// Steps: build allowed origins list once at startup so handshake checks are cheap and deterministic.
const CORS_ORIGINS: (string | undefined)[] = [
	process.env.BACK_END,
	process.env.FRONT_END,
	...(process.env.CORS_ORIGINS?.split(',') || []),
	...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
].filter(Boolean);

const ONLINE_USERS_KEY: string = REDIS_KEYS.onlineUsers;
const MAX_PAYLOAD_SIZE: number = 262144;

// Singleton state
let io: Server | null = null;
let redis: ioRedisType | null = null;
let initialized: boolean = false;

const ioRedisSetter = (client: ioRedisType | null): ioRedisType | null => (redis = client);

// SOCKET GETTER ---------------------------------------------------------------
// Steps: allow other modules to emit without passing an HTTP server handle.
// LEARNING NOTE: `Socket(server)` is an initializer; callers that only need the live instance should use this getter.
function getSocketIOInstance(): Server | null {
	return io;
}

// SOCKET SERVER INITIALIZATION -------------------------------------------------
// Steps: initialize singleton io once, wire redis adapter for cross-worker fanout, configure transport/ping for proxy stability,
// then install the connection handler and publish `io` to other modules via setters.
async function Socket(server: any): Promise<Server | null> {
	if (io) return io;
	if (initialized) return io;

	try {
		if (!redis) redis = await Redis.getClient();
		if (!redis) throw new Error('Redis client required for socket.io initialization');

		const pub: ioRedisType = redis;
		const sub: ioRedisType = await (pub as any).duplicate();

		io = new Server(server, {
			cors: { origin: CORS_ORIGINS as string[], methods: ['GET', 'POST'], credentials: true },
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
		} catch (workerErr: any) {
			logger.info('setupWorker skipped (not in cluster mode or unsupported)', { error: workerErr?.message });
		}

		// CLEANUP STALE DATA ---------------------------------------------------
		// Steps: clear online-users set only in MIN_MODE (single process) so dev/test restarts don't leave stale online markers; cluster mode cannot safely clear shared state.
		if (MIN_MODE && redis) await redis.del(ONLINE_USERS_KEY);

		io.on('connection', handleConnection);
		io.on('error', (err: Error) => logger.error('Socket server error', { error: err?.message }));

		socketSetter(io);
		entranceSocketSetter(io);

		initialized = true;
		reportSubsystemReady('SOCKET_IO');
		return io;
	} catch (error: any) {
		logger.error('Socket init failed', { error: error?.message });
		throw error;
	}
}

interface AuthSocketData {
	userID: string | number;
	devID: string;
	tokenExpiry: number;
	devicePrint: string | null;
	redisKey: string;
}

// AUTHENTICATE SOCKET ----------------------------------------------------------
// Steps: verify JWT, check session exists in Redis (revocation), enforce device binding (devID + optional print) to prevent token reuse across devices.
async function authenticateSocket(socket: any): Promise<AuthSocketData> {
	const { token, devID: clientDevID, print: clientPrint } = socket.handshake?.auth || {};

	if (!token) throw new Error('missingToken');

	let decoded: any;
	try {
		// JWT VERIFY ------------------------------------------------------------
		// LEARNING NOTE: jwtQuickies typing expects extra fields even in verify mode; cast locally to avoid infecting callsites.
		decoded = (jwtQuickies as any)({ mode: 'verify', payload: token });
	} catch (err: any) {
		logger.alert('Socket auth token verification failed', { error: err?.message });
		throw new Error(err?.message === 'tokenExpired' ? 'needNewAccessToken' : 'unauthorized');
	}

	const { userID, devID, exp }: any = decoded;
	if (!userID || !devID) throw new Error('unauthorized');

	if (clientDevID && clientDevID !== devID) throw new Error('unauthorized');

	const redisKey: string = `${userID}_${devID}`;
	if (!redis) throw new Error('Redis client required');
	const storedEntry: string | null = await redis.hget(REDIS_KEYS.refreshTokens, redisKey);
	if (!storedEntry) throw new Error('sessionInvalidated');

	// Handle print values that may contain colons (same fix as jwtokens.js) ---------------------------
	const entryStr: string = String(storedEntry),
		colonIdx: number = entryStr.indexOf(':'),
		storedPrint: string = colonIdx >= 0 ? entryStr.slice(colonIdx + 1) : '';

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
async function handleConnection(socket: any): Promise<void> {
	try {
		// 1. Authenticate
		const auth: AuthSocketData = await authenticateSocket(socket);
		socket.userID = auth.userID;
		socket.devID = auth.devID;
		socket.tokenExpiry = auth.tokenExpiry;
		socket.devicePrint = auth.devicePrint;
		socket.redisKey = auth.redisKey;

		// 2. Mark user online and join personal room
		if (!redis) throw new Error('Redis client required');
		await redis.sadd(ONLINE_USERS_KEY, String(auth.userID));
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
	} catch (error: any) {
		const msg: string = error?.message || 'unauthorized';
		logger.alert('Socket auth failed', { error: msg, socketId: socket.id });
		socket.emit('error', msg);
		socket.disconnect(true);
	}
}

// INSTALL MIDDLEWARE -----------------------------------------------------------
// Steps: block expired access tokens (except refreshAuth), enforce payload size cap, sanitize payload shape, then attach userID before handlers run.
function installMiddleware(socket: any): void {
	socket.use(async ([event, data, ack]: [string, any, any], next: (err?: Error) => void) => {
		try {
			if (event !== 'refreshAuth') {
				if (socket.tokenExpiry && Date.now() > socket.tokenExpiry) {
					socket.emit('error', 'needNewAccessToken');
					return typeof ack === 'function' ? ack({ error: 'needNewAccessToken' }) : next(new Error('needNewAccessToken'));
				}
			}

			if (data) {
				try {
					// PAYLOAD SIZE ESTIMATE ------------------------------------------------
					// Avoid JSON.stringify on attacker-controlled payloads (CPU spike / memory pressure).
					const size: number = typeof data === 'string' ? data.length : estimateSocketPayloadSize(data);
					if (size > MAX_PAYLOAD_SIZE) {
						return typeof ack === 'function' ? ack({ error: 'payloadTooLarge' }) : next(new Error('payloadTooLarge'));
					}
				} catch {}
			}

			if (data && event !== 'refreshAuth' && typeof sanitizeSocketPayload === 'function') {
				try {
					const sanitized: any = sanitizeSocketPayload(data);
					if (sanitized === null) return next(new Error('invalidPayload'));
					// Clear original keys and apply only sanitized keys to prevent malicious key persistence
					for (const key of Object.keys(data)) delete data[key];
					Object.assign(data, sanitized);
					data.userID = socket.userID;
				} catch (err: any) {
					logger.error('Socket middleware error', { error: err?.message, socketId: socket.id });
					return next(new Error('middlewareError'));
				}
			}

			next();
		} catch (error: any) {
			next(error);
		}
	});
}

// PAYLOAD SIZE ESTIMATE --------------------------------------------------------
// Steps: produce a bounded, fast estimate of payload size to avoid expensive JSON.stringify in socket middleware.
function estimateSocketPayloadSize(value: any): number {
	// FAST PATHS ---------------------------------------------------------------
	if (value == null) return 0;
	if (typeof value === 'string') return value.length;
	if (typeof value === 'number' || typeof value === 'boolean') return 8;
	if (typeof value === 'bigint') return 16;
	if (Buffer.isBuffer(value)) return value.length;
	if (ArrayBuffer.isView(value)) return Number((value as any).byteLength || 0);

	// BOUNDED WALK -------------------------------------------------------------
	const MAX_NODES = 2000;
	const MAX_DEPTH = 8;
	const MAX_BYTES = MAX_PAYLOAD_SIZE + 1; // Stop once we know it exceeds cap
	const seen = new Set<any>();
	let nodesVisited = 0;

	const walk = (node: any, depth: number): number => {
		if (node == null) return 0;
		if (nodesVisited++ > MAX_NODES) return MAX_BYTES;
		if (depth > MAX_DEPTH) return MAX_BYTES;
		if (typeof node === 'string') return node.length;
		if (typeof node === 'number' || typeof node === 'boolean') return 8;
		if (typeof node === 'bigint') return 16;
		if (Buffer.isBuffer(node)) return node.length;
		if (ArrayBuffer.isView(node)) return Number((node as any).byteLength || 0);
		if (typeof node !== 'object') return 0;
		if (seen.has(node)) return 0;
		seen.add(node);

		if (Array.isArray(node)) {
			let total = 2;
			for (const item of node) {
				total += walk(item, depth + 1);
				if (total >= MAX_BYTES) return MAX_BYTES;
			}
			return total;
		}

		let total = 2;
		for (const [key, child] of Object.entries(node)) {
			total += Math.min(String(key).length, 256);
			total += walk(child, depth + 1);
			if (total >= MAX_BYTES) return MAX_BYTES;
		}
		return total;
	};

	return walk(value, 0);
}

// SETUP EVENT HANDLERS --------------------------------------------------------
// Steps: register chat/membership/moderation handlers, then install refreshAuth handler to update tokenExpiry without reconnecting.
function setupEventHandlers(socket: any): void {
	socket.on('message', (data: any, cb: any) => sendMessage(socket, data, cb));
	socket.on('joinRoom', (data: any, cb: any) =>
		joinRoom({ socket, userID: socket.userID, ...data, callback: cb }).catch((err: any) => {
			logger.error('joinRoom failed', { error: err?.message, userID: socket.userID, ...data });
			cb?.({ error: err?.message || 'joinRoom failed' });
		})
	);
	socket.on('punishment', (data: any, cb: any) => punishment(socket, data, cb));
	socket.on('messSeen', (data: any, cb: any) => messSeen(socket, data, cb));
	socket.on('blocking', (data: any, cb: any) => blocking(socket, data, cb));

	socket.on('refreshAuth', async ({ token, expiresAt }: any = {}, cb: any) => {
		try {
			if (!token) return cb?.({ error: 'unauthorized' });

			const decoded: any = (jwtQuickies as any)({ mode: 'verify', payload: token });
			const { userID, devID, exp }: any = decoded;

			if (userID !== socket.userID || devID !== socket.devID) return cb?.({ error: 'unauthorized' });

			if (!redis) throw new Error('Redis client required');
			const sessionExists: number = await redis.hexists(REDIS_KEYS.refreshTokens, socket.redisKey);
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
async function handleDisconnecting(socket: any): Promise<void> {
	const { userID }: any = socket;
	if (!userID) return;

	// Capture rooms before they're cleared
	socket._capturedRooms = [...socket.rooms];

	try {
		if (!io) return;
		const userSockets: Set<string> = await io.in(String(userID)).allSockets();
		const isLastSocket: boolean = userSockets.size <= 1;

		if (isLastSocket && redis) {
			// Mark user as left in each chat room
			for (const room of socket.rooms) {
				if (room.startsWith('chat_')) {
					const chatID: string = room.split('_')[1];
					await redis.sadd(`${REDIS_KEYS.chatLeftUsers}:${chatID}`, String(userID));
					socket.to(room).emit('userLeft', { chatID, userID });
				}
			}
		}
	} catch (error: any) {
		logger.error('handleDisconnecting error', { error: error?.message, userID });
	}
}

// HANDLE DISCONNECT -----------------------------------------------------------
// Steps: if user has no remaining sockets, remove them from online set, then check captured chat rooms and schedule cleanup when a room becomes empty.
async function handleDisconnect(socket: any): Promise<void> {
	const { userID }: any = socket;
	if (!userID) return;

	try {
		if (!io) return;
		// Check if user has any remaining sockets
		const userSockets: Set<string> = await io.in(String(userID)).allSockets();

		if (userSockets.size === 0 && redis) {
			// No more sockets - remove from online immediately
			// If user reconnects quickly (connection state recovery), they'll be re-added
			// Any alerts during this gap go to userSummary and user fetches via HTTP
			await redis.srem(ONLINE_USERS_KEY, String(userID));
			logger.info('User went offline', { userID });
		}

		// Clean up empty chat rooms
		const capturedRooms: string[] = (socket as any)._capturedRooms || [];
		for (const room of capturedRooms) {
			if (!room.startsWith('chat_')) continue;
			const chatID: string = room.split('_')[1];

			try {
				const socketsInRoom: Set<string> = await io.in(room).allSockets();
				if (socketsInRoom.size === 0) {
					await cleanupEmptyChat(chatID);
				}
			} catch (err: any) {
				logger.alert('Chat cleanup check failed', { chatID, error: err?.message });
			}
		}

		delete (socket as any)._capturedRooms;
	} catch (error: any) {
		logger.error('handleDisconnect error', { error: error?.message, userID });
	}
}

// CHAT CLEANUP ----------------------------------------------------------------
// Steps: wait for a short grace window, re-check room emptiness, then remove per-chat Redis keys (active sets + left-users) so state does not accumulate.
const CLEANUP_DELAY_MS: number = 5000; // 5 seconds grace period for reconnection

async function cleanupEmptyChat(chatID: string | number): Promise<void> {
	try {
		// Wait briefly to allow for connection state recovery (user may reconnect quickly)
		await new Promise(resolve => setTimeout(resolve, CLEANUP_DELAY_MS));

		if (!io) return;
		// Re-check if room is still empty after delay (user may have reconnected)
		const socketsInRoom: Set<string> = await io.in(`chat_${chatID}`).allSockets();
		if (socketsInRoom.size > 0) {
			logger.info('Chat cleanup skipped - users reconnected', { chatID, socketCount: socketsInRoom.size });
			return;
		}

		if (!redis) return;
		const members: string[] = await redis.smembers(`${REDIS_KEYS.chatMembers}:${chatID}`);
		// Check for null/undefined/empty array - smembers returns [] for missing key
		if (!members || !Array.isArray(members) || members.length === 0) {
			// Still clean up left_users even if no members
			await redis.del(`${REDIS_KEYS.chatLeftUsers}:${chatID}`);
			return;
		}

		const pipe: any = redis.multi();
		for (const memberID of members) {
			pipe.srem(`userActiveChats:${memberID}`, chatID);
		}
		pipe.del(`${REDIS_KEYS.chatLeftUsers}:${chatID}`);
		await pipe.exec();

		logger.info('Cleaned up empty chat', { chatID, memberCount: members.length });
	} catch (error: any) {
		logger.error('cleanupEmptyChat error', { error: error?.message, chatID });
	}
}

// REJOIN CHAT ROOMS -----------------------------------------------------------
// Steps: read userActiveChats set, join those rooms, clear left-users membership entries, then clear summary dot only after successful rejoin.
async function rejoinChatRooms(socket: any): Promise<void> {
	const { userID }: any = socket;

	try {
		if (!redis) return;
		const activeChats: string[] = await redis.smembers(`userActiveChats:${userID}`);
		if (!activeChats?.length) {
			// No active chats, safe to clear notification
			await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'chats', 0);
			return;
		}

		const joinPromises: Promise<void>[] = [];
		const cleanupPipe: any = redis.pipeline();

		const joined: number[] = [];
		let needsCleanup: boolean = false;
		for (const chatID of activeChats) {
			joinPromises.push(socket.join(`chat_${chatID}`));
			// Clean up "left users" flag since they are now back online in the room
			cleanupPipe.srem(`${REDIS_KEYS.chatLeftUsers}:${chatID}`, String(userID));
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
	} catch (error: any) {
		logger.error('rejoinChatRooms error', { error: error?.message, userID });
	}
}

interface EmitToUsersProps {
	mode: string;
	userID: string | number;
	otherUserID: string | number;
	miniProfiles?: any;
	message?: any;
	note?: any;
}

// EMIT TO USERS ---------------------------------------------------------------
// Steps: emit to recipient if online, otherwise set summary alert flag; then emit mirror payload to sender’s other devices for cross-device consistency.
async function emitToUsers({ mode, userID, otherUserID, miniProfiles = {}, message = null, note = null }: EmitToUsersProps): Promise<void> {
	try {
		if (!io || !redis) {
			logger.alert('emitToUsers: Socket or Redis not initialized');
			if (redis) await redis.hset(`${REDIS_KEYS.userSummary}:${otherUserID}`, 'alerts', 1);
			return;
		}

		const otherUserIsOnline: number = await redis.sismember(ONLINE_USERS_KEY, String(otherUserID));
		let emitSuccess: boolean = false;

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
			const senderSockets: Set<string> = await io.in(String(userID)).allSockets();
			if (senderSockets.size > 1) {
				const payloadOut: any = { dir: 'out', target: otherUserID };
				if (miniProfiles[otherUserID]) payloadOut.data = { ...miniProfiles[otherUserID], ...(note && { note }) };
				io.to(String(userID)).emit(mode, payloadOut);
			}
		} catch (error: any) {
			logger.alert('emitToUsers: failed to emit to sender devices', { error: error?.message, userID });
		}
	} catch (error: any) {
		logger.error('emitToUsers error', { error: error?.message, mode, userID, otherUserID });
		// Ensure alert flag is set if emit failed unexpectedly
		try {
			if (redis) await redis.hset(`${REDIS_KEYS.userSummary}:${otherUserID}`, 'alerts', 1);
		} catch (e: any) {
			logger.error('emitToUsers: failed to set alert flag', { error: e?.message, otherUserID });
		}
	}
}

interface OnlineStatusResult {
	online: Set<string | number>;
	offline: Set<string | number>;
}

// GET ONLINE STATUS -----------------------------------------------------------
// Steps: smismember against ONLINE_USERS_KEY, then partition ids into online/offline sets for downstream decisions.
async function getOnlineStatus(userIds: (string | number)[]): Promise<OnlineStatusResult> {
	if (!Array.isArray(userIds) || !userIds.length || !redis) {
		return { online: new Set(), offline: new Set() };
	}

	try {
		const online: Set<string | number> = new Set();
		const offline: Set<string | number> = new Set();
		const results: number[] = await redis.smismember(ONLINE_USERS_KEY, userIds.map(String));

		for (let i = 0; i < userIds.length; i++) {
			(results[i] ? online : offline).add(userIds[i]);
		}

		return { online, offline };
	} catch (error: any) {
		logger.error('getOnlineStatus error', { error: error?.message });
		return { online: new Set(), offline: new Set(userIds) };
	}
}

export { Socket, emitToUsers, ioRedisSetter, getOnlineStatus, getSocketIOInstance };
