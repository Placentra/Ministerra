import { io } from 'socket.io-client';
import axios from 'axios';
import { getToken } from '../../utils/getToken';
import { notifyGlobalError } from '../useErrorsMan';
import { getDeviceFingerprint } from '../../../helpers';

// ============================================================================
// CONFIG
// ============================================================================
const EMIT_TIMEOUT = 8000;
const TOKEN_REFRESH_MARGIN_MS = 5000; // Refresh if token expires within 5s
const SOCKET_URL = import.meta.env.VITE_SOCKET_STICKY || import.meta.env.VITE_BACK_END;

const SOCKET_STATES = {
	IDLE: 'idle',
	CONNECTING: 'connecting',
	READY: 'ready',
	DISCONNECTED: 'disconnected',
};

// ============================================================================
// HELPERS
// ============================================================================
// DECODE DEV ID FROM JWT -------------------------------------------------------
// Steps: base64-decode JWT payload without verifying (caller already trusts source), then pluck devID so we can bind socket session to a device id for server-side checks.
function decodeDevIdFromToken(token) {
	try {
		const [, payload] = String(token).split('.');
		if (!payload) return null;
		return JSON.parse(atob(payload))?.devID || null;
	} catch (_) {
		return null;
	}
}

let cachedFingerprint = null;
// GET DEVICE FINGERPRINT (CACHED) ---------------------------------------------
// Steps: compute fingerprint once per tab to avoid repeated hashing; on failure, fall back to empty string so auth still proceeds (server may enforce print only when stored).
function getFingerprint() {
	if (cachedFingerprint === null) {
		try {
			cachedFingerprint = getDeviceFingerprint();
		} catch (_) {
			cachedFingerprint = '';
		}
	}
	return cachedFingerprint;
}

// REFRESH TOKEN VIA HTTP -------------------------------------------------------
// Steps: load current aJWT, call `/entrance` renewal (uses refresh cookie), then parse `Authorization` header into {token,expiresAt} and attach devID+print for socket auth.
async function refreshToken() {
	// GET CURRENT TOKEN FROM INDEXEDDB ---------------------------
	const tokenInfo = await getToken();
	const currentToken = tokenInfo?.token;
	if (!currentToken) throw new Error('noToken');

	const response = await axios.post('/entrance', { mode: 'renewAccessToken' }, { headers: { Authorization: `Bearer ${currentToken}` }, withCredentials: true, __skipLogoutCleanup: true } as any); // SEND CURRENT TOKEN + REFRESH COOKIE ---------------------------
	const authHeader = response?.headers?.authorization;
	if (!authHeader) throw new Error('noToken');

	const [bearerPart = '', expiryPart] = String(authHeader).split(':');
	const token = bearerPart.includes(' ') ? bearerPart.split(' ')[1] : bearerPart;
	if (!token) throw new Error('noToken');

	return { token, expiresAt: Number(expiryPart) || null, devID: decodeDevIdFromToken(token), print: getFingerprint() };
}

// BUILD SOCKET AUTH PAYLOAD ----------------------------------------------------
// Steps: load token metadata, refresh when expired/forced, otherwise reuse stored token; always attach devID+print so server can enforce device binding.
async function getAuthPayload(forceRefresh = false) {
	const tokenInfo = await getToken();

	// No token or expired - refresh
	if (!tokenInfo?.token || tokenInfo.expired || forceRefresh) {
		return refreshToken();
	}

	return {
		token: tokenInfo.token,
		expiresAt: tokenInfo.expiry,
		devID: decodeDevIdFromToken(tokenInfo.token),
		print: getFingerprint(),
	};
}

// ============================================================================
// SOCKET TRANSPORT - Simple singleton
// ============================================================================
/** ----------------------------------------------------------------------------
 * SOCKET TRANSPORT CLASS
 * Low-level socket management: connection, reconnection, auth refresh,
 * and state tracking. Handles token lifecycle and network recovery.
 * -------------------------------------------------------------------------- */
class SocketTransport {
	// CLASS FIELDS -------------------------------------------------------------
	// Steps: declare fields explicitly so TS knows they exist; keep them `any` to avoid refactors while stabilizing compilation.
	socket: any;
	state: any;
	stateListeners: Set<any>;
	connectPromise: any;
	lastAuthExpiry: any;
	refreshPromise: any;
	reconnectBlocked: boolean;

	constructor() {
		this.socket = null;
		this.state = SOCKET_STATES.IDLE;
		this.stateListeners = new Set();
		this.connectPromise = null;
		this.lastAuthExpiry = null;
		this.refreshPromise = null;
		this.reconnectBlocked = false;
	}

	_cleanupSocket(sock) {
		// SOCKET TEARDOWN -----------------------------------------------------
		// Steps: remove listeners first (avoid duplicate handlers), then disconnect; best-effort because socket may already be dead.
		if (!sock) return;
		try {
			sock.removeAllListeners();
		} catch (_) {}
		try {
			sock.disconnect();
		} catch (_) {}
	}

	// State management
	getState() {
		return this.state;
	}

	setState(state, meta = {}) {
		// STATE BROADCAST -----------------------------------------------------
		// Steps: skip no-op transitions, store state, then fanout to listeners so hooks can react without polling.
		if (this.state === state) return;
		this.state = state;
		for (const listener of this.stateListeners) {
			try {
				listener({ state, meta });
			} catch (_) {}
		}
	}

	onState(handler) {
		this.stateListeners.add(handler);
		return () => this.stateListeners.delete(handler);
	}

	// Connection
	async connect() {
		// CONNECT DEDUPE ------------------------------------------------------
		// Steps: reuse existing connected socket or in-flight connect promise so multiple callers don’t create parallel sockets.
		if (this.socket?.connected) return this.socket;
		if (this.connectPromise) return this.connectPromise;

		this.connectPromise = this._connect();
		try {
			return await this.connectPromise;
		} finally {
			this.connectPromise = null;
		}
	}

	async _connect() {
		this.setState(SOCKET_STATES.CONNECTING);

		try {
			// If a previous socket exists (even disconnected), tear it down before creating a new one.
			// Otherwise you can end up with multiple Socket.IO instances reconnecting in parallel.
			if (this.socket) {
				this._cleanupSocket(this.socket);
				this.socket = null;
			}

			// AUTH FETCH --------------------------------------------------------
			// Steps: build auth payload first so socket handshake is authenticated and server can recover state immediately.
			const auth = await getAuthPayload();
			this.lastAuthExpiry = auth.expiresAt;

			const socket = io(SOCKET_URL, {
				auth,
				transports: ['websocket', 'polling'],
				reconnection: true,
				reconnectionDelay: 1000,
				reconnectionDelayMax: 15000,
				reconnectionAttempts: Infinity,
				timeout: 15000,
				withCredentials: true,
			});

			return new Promise((resolve, reject) => {
				// CONNECT TIMEOUT -------------------------------------------------
				// Steps: cap handshake time so UI can fall back to HTTP mode instead of hanging forever on a dead network.
				const timeout = setTimeout(() => {
					this._cleanupSocket(socket);
					reject(new Error('connectionTimeout'));
				}, 20000);

				socket.once('connect', () => {
					clearTimeout(timeout);
					this.socket = socket;
					this.setupSocketEvents(socket);
					this.setState(SOCKET_STATES.READY, { recovered: socket.recovered });
					this.reconnectBlocked = false;
					resolve(socket);
				});

				socket.once('connect_error', err => {
					clearTimeout(timeout);
					this._cleanupSocket(socket);
					this.setState(SOCKET_STATES.DISCONNECTED, { error: err?.message });
					reject(err);
				});
			});
		} catch (err) {
			this.setState(SOCKET_STATES.DISCONNECTED, { error: err?.message });
			throw err;
		}
	}

	async reconnectAfterAuth(source = '') {
		// FORCE RECONNECT AFTER AUTH -----------------------------------------
		// Steps: refresh auth first (so next handshake is valid), then reconnect; used when server kicks due to expired/rotated tokens.
		try {
			await this.refreshAuth();
		} catch (err) {
			console.error('[socket] auth refresh failed:', err);
			throw err;
		}
		try {
			await this.connect();
		} catch (err) {
			console.error('[socket] reconnect failed:', { source, err: err?.message || err });
			throw err;
		}
	}

	setupSocketEvents(socket) {
		// SERVER-DRIVEN STATE -------------------------------------------------
		// Steps: keep local state aligned with server disconnects and auth errors; only auto-reconnect when it’s safe (not sessionInvalidated/logout).
		socket.on('disconnect', reason => {
			console.log('[socket] disconnected:', reason);
			this.setState(SOCKET_STATES.DISCONNECTED, { reason });
			if (reason === 'io server disconnect' && !this.reconnectBlocked) this.reconnectAfterAuth('io_server_disconnect').catch(() => {});
		});

		socket.on('connect', () => {
			console.log('[socket] reconnected');
			this.setState(SOCKET_STATES.READY, { recovered: socket.recovered });
		});

		socket.on('error', async err => {
			console.warn('[socket] error:', err);
			const message = typeof err === 'string' ? err : err?.message;

			if (message === 'needNewAccessToken') {
				if (!this.reconnectBlocked) await this.reconnectAfterAuth('needNewAccessToken').catch(() => {});
				return;
			}

			if (message === 'sessionInvalidated' || message === 'logout') {
				this.reconnectBlocked = true;
				notifyGlobalError(new Error(message));
				this.disconnect();
			}
		});
	}

	// Check if token needs refresh before emit - async to check actual stored token ---------------------------
	async tokenNeedsRefresh() {
		// REFRESH DECISION ----------------------------------------------------
		// Steps: read current stored token, refresh if missing/near-expiry, also refresh if socket.auth diverged from stored token to avoid server seeing stale token.
		const tokenInfo = await getToken();
		if (!tokenInfo?.token || !tokenInfo?.expiry) return true; // NO TOKEN OR EXPIRY = REFRESH ---------------------------
		const expiresWithinMargin = Date.now() + TOKEN_REFRESH_MARGIN_MS > tokenInfo.expiry;
		const socketTokenMismatch = this.socket?.auth?.token && this.socket.auth.token !== tokenInfo.token; // SOCKET HAS OLD TOKEN ---------------------------
		const needsRefresh = expiresWithinMargin || socketTokenMismatch;
		if (!needsRefresh) this.lastAuthExpiry = tokenInfo.expiry;
		// if (import.meta.env.DEV) console.log('[socket] tokenNeedsRefresh:', { needsRefresh, expiresWithinMargin, socketTokenMismatch, storedExpiry: tokenInfo.expiry, now: Date.now() });
		return needsRefresh;
	}

	// Refresh auth - deduplicated
	async refreshAuth() {
		if (this.refreshPromise) return this.refreshPromise;

		this.refreshPromise = this._refreshAuth();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	async _refreshAuth() {
		try {
			// AUTH ROTATION -----------------------------------------------------
			// Steps: force refresh via HTTP so cookie-based refresh can mint a new access token, then push refreshAuth event over socket so server updates token expiry without reconnect.
			const auth = await getAuthPayload(true);
			this.lastAuthExpiry = auth.expiresAt;
			if (this.socket) this.socket.auth = auth; // UPDATE SOCKET AUTH OBJECT ---------------------------

			if (this.socket?.connected) {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('refreshAuthTimeout')), 5000);
					this.socket.emit('refreshAuth', { token: auth.token, expiresAt: auth.expiresAt }, ack => {
						clearTimeout(timer);
						if (ack?.error) reject(new Error(ack.error));
						else resolve(ack);
					});
				});
			}
			if (import.meta.env.DEV) console.log('[socket] auth refreshed, new expiry:', auth.expiresAt);
			return auth;
		} catch (err) {
			console.error('[socket] auth refresh failed:', err);
			throw err;
		}
	}

	disconnect() {
		// MANUAL DISCONNECT ---------------------------------------------------
		// Steps: tear down socket and clear auth markers so next connect starts fresh; used on logout/user switch.
		if (this.socket) {
			this._cleanupSocket(this.socket);
			this.socket = null;
		}
		this.lastAuthExpiry = null;
		this.setState(SOCKET_STATES.DISCONNECTED, { reason: 'manual' });
	}

	// Ensure connected before operations
	async ensureReady() {
		if (this.socket?.connected) return this.socket;
		return this.connect();
	}

	// Emit with proactive token refresh
	async emit(event, payload, { timeout = EMIT_TIMEOUT } = {}) {
		// Proactive token refresh if expiring soon - AWAIT ASYNC CHECK ---------------------------
		// Steps: refresh token before emit so server won’t reject with needNewAccessToken mid-flight; on refresh failure we still try emit to allow fallback-to-HTTP upstream.
		if (await this.tokenNeedsRefresh()) {
			try {
				await this.refreshAuth();
			} catch (err) {
				console.warn('[socket] proactive refresh failed, proceeding with emit:', err.message);
			}
		}

		const socket = await this.ensureReady();
		window.dispatchEvent(new CustomEvent('requestActivity', { detail: { type: 'start', source: 'socket' } })); // GLOBAL LOADING INDICATOR ---------------------------

		return new Promise((resolve, reject) => {
			// ACK TIMEOUT -------------------------------------------------------
			// Steps: cap per-emit wait so UI can fall back to axios path instead of hanging on a missing ack.
			const timer = setTimeout(() => {
				window.dispatchEvent(new CustomEvent('requestActivity', { detail: { type: 'end', source: 'socket' } })); // GLOBAL LOADING INDICATOR ---------------------------
				reject(new Error(`emitTimeout:${event}`));
			}, timeout);

			socket.emit(event, payload, response => {
				clearTimeout(timer);
				window.dispatchEvent(new CustomEvent('requestActivity', { detail: { type: 'end', source: 'socket' } })); // GLOBAL LOADING INDICATOR ---------------------------
				if (response?.error) {
					const err: any = new Error(response.error);
					if (response.retryAfterMs) err.retryAfterMs = response.retryAfterMs;
					reject(err);
				} else {
					resolve(response);
				}
			});
		});
	}
}

// ============================================================================
// SINGLETON
// ============================================================================
let transport = null;

export function getSocketTransport() {
	// SINGLETON ACCESS -------------------------------------------------------
	// Steps: return the one transport instance so listeners and auth refresh stay centralized across hooks/components.
	if (!transport) {
		transport = new SocketTransport();
	}
	return transport;
}

export { SOCKET_STATES };
