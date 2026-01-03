import ioRedis, { RedisOptions } from 'ioredis';
import os from 'os';
import { ioRedisSetter as alertsSetter } from '../../modules/alerts';
import { ioRedisSetter as chatSetter } from '../../modules/chat';
import { ioRedisSetter as contentSetter } from '../../modules/content';
import { ioRedisSetter as discussionSetter } from '../../modules/discussion';
import { ioRedisSetter as editorSetter } from '../../modules/editor/index';
import { ioRedisSetter as entranceSetter } from '../../modules/entrance/index';
import { ioRedisSetter as eventSetter } from '../../modules/event';
import { ioRedisSetter as foundationSetter } from '../../modules/foundation';
import { ioRedisSetter as interestsSetter } from '../../modules/interests';
import { ioRedisSetter as jwtSetter } from '../../modules/jwtokens';
import { ioRedisSetter as ratingSetter } from '../../modules/rating';
import { ioRedisSetter as userSetter } from '../../modules/user';
import { ioRedisSetter as setupSetter } from '../../modules/setup/index';
import { ioRedisSetter as socketSetter } from '../../systems/socket/socket';
import { ioRedisSetter as contentFiltersSetter } from '../../utilities/contentFilters';
import { ioRedisSetter as contentHelpersSetter } from '../../utilities/contentHelpers';
import { ioRedisSetter as cacheSetter } from '../../utilities/helpers/cache';
import { ioRedisSetter as locationSetter } from '../../utilities/helpers/location';
import { ioRedisSetter as chatHandlersSetter } from '../../systems/socket/chatHandlers';
import { ioRedisSetter as invitesSetter } from '../../modules/invites';
import { ioRedisSetter as quickQueriesSetter } from '../../modules/chat/quickQueries';
import { getLogger } from '../handlers/loggers';
import { createCircuitBreaker } from '../handlers/circuitBreaker';
import { reportSubsystemReady } from '../../cluster/readiness';

const logger = getLogger('Redis');

// CIRCUIT BREAKER --------------------------------------------------------------
// Guards Redis commands so transient outages don't turn into unbounded request hangs.
// The breaker is used by proxy-wrapping the ioredis client and recording command latency/failures.
// Steps: fail fast under outage, then gradually recover when Redis stabilizes; prevents request handlers from piling up behind slow/hung commands.
const redisCircuitBreaker = createCircuitBreaker('Redis', {
	failureThreshold: 5,
	successThreshold: 2,
	timeout: 5000, // 5s timeout for Redis operations
	resetTimeout: 30000, // Try again after 30s
	volumeThreshold: 10,
});

// CIRCUIT BREAKER PROXY --------------------------------------------------------
// Wraps Redis commands with circuit breaker execute() while excluding connection-management APIs.
// Note: pipeline()/multi() are intentionally NOT wrapped because they return non-promise builder objects.
// Steps: proxy-wrap only promise-returning redis commands, route them through breaker.execute(), and leave builder/connection APIs untouched.
function createCircuitBreakerProxy(client) {
	// Commands that should NOT be wrapped (connection management or non-promise APIs)
	const skipCommands = new Set([
		'on',
		'once',
		'off',
		'emit',
		'quit',
		'disconnect',
		'connect',
		'status',
		'scanStream',
		'sscanStream',
		'hscanStream',
		'zscanStream',
		'xgroup',
		'xreadgroup',
		'xreadgroupBuffer',
		'xack',
		'xautoclaim',
		'xautoclaimBuffer',
		'xread',
		'xreadBuffer',
	]);

	return new Proxy(client, {
		get(target, prop) {
			const value = target[prop];

			// Skip non-command properties
			if (typeof value !== 'function' || typeof prop !== 'string' || skipCommands.has(prop)) {
				return value;
			}

			// Wrap command with circuit breaker
			return function (...args) {
				// For some operations like multi(), return the original (it returns a Pipe object)
				if (prop === 'multi' || prop === 'pipeline') {
					return value.apply(target, args);
				}

				// Wrap command execution with circuit breaker
				return redisCircuitBreaker.execute(
					async () => {
						return await value.apply(target, args);
					},
					{
						command: prop,
						argsCount: args.length,
						// Preview first arg if string (usually key)
						argsPreview: args.length > 0 && typeof args[0] === 'string' ? args[0] : null,
					}
				);
			};
		},
	});
}

let redisClient: any = null,
	connectionState = 'disconnected',
	isInitializing = false,
	initPromise: Promise<void> | null = null,
	healthCheckInterval: any = null,
	poolHealthCheckInterval: any = null,
	sentinelConfigLogged = false;
let connectionPool = [],
	availableConnections = [],
	pendingAcquisitions = [],
	isPoolInitialized = false;

// Serialize pool replacements to avoid stampedes under flapping conditions.
let poolReplacementChain = Promise.resolve();
const clientSetters = [
	alertsSetter,
	chatSetter,
	contentSetter,
	discussionSetter,
	editorSetter,
	entranceSetter,
	eventSetter,
	foundationSetter,
	interestsSetter,
	jwtSetter,
	ratingSetter,
	setupSetter,
	userSetter,
	contentFiltersSetter,
	contentHelpersSetter,
	cacheSetter,
	locationSetter,
	socketSetter,
	chatHandlersSetter,
	invitesSetter,
	quickQueriesSetter,
];
const CPU_COUNT = Math.max(1, os.cpus().length);
// POOL SIZING: With clustering, each worker gets its own pool. Total = POOL_SIZE * numWorkers ---
// Keep per-worker pool small (2-8); autoPipelining handles concurrency efficiently ---
const env = {
	REDIS_MAX_ATTEMPTS: Number(process.env.REDIS_MAX_ATTEMPTS) || 5,
	REDIS_ATTEMPT_DELAY: Number(process.env.REDIS_ATTEMPT_DELAY) || 1000,
	REDIS_HEALTH_CHECK_INTERVAL: Number(process.env.REDIS_HEALTH_CHECK_INTERVAL) || 10000,
	REDIS_POOL_SIZE: Number(process.env.REDIS_POOL_SIZE) || 4,
	REDIS_POOL_MIN_SIZE: Number(process.env.REDIS_POOL_MIN_SIZE) || 1,
	REDIS_POOL_ACQUIRE_TIMEOUT: Number(process.env.REDIS_POOL_ACQUIRE_TIMEOUT) || 5000,
	REDIS_POOL_IDLE_TIMEOUT: Number(process.env.REDIS_POOL_IDLE_TIMEOUT) || 30000,
	REDIS_KEEP_ALIVE: Number(process.env.REDIS_KEEP_ALIVE) || 900000,
	REDIS_CONNECT_TIMEOUT: Number(process.env.REDIS_CONNECT_TIMEOUT) || 10000,
	REDIS_HOST: process.env.REDIS_HOST || 'localhost',
	REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
	REDIS_PASSWORD: process.env.REDIS_PASSWORD,
	REDIS_TLS: process.env.REDIS_TLS === 'true',
	// Sentinel support
	REDIS_USE_SENTINEL: String(process.env.REDIS_USE_SENTINEL || '').trim() === 'true',
	REDIS_SENTINEL_NAME: String(process.env.REDIS_SENTINEL_NAME || 'mymaster').trim(),
	REDIS_SENTINELS: String(process.env.REDIS_SENTINELS || '').trim(), // host1:26379,host2:26379,host3:26379
	REDIS_SENTINEL_PASSWORD: process.env.REDIS_SENTINEL_PASSWORD,
};
const {
	REDIS_MAX_ATTEMPTS,
	REDIS_ATTEMPT_DELAY,
	REDIS_HEALTH_CHECK_INTERVAL,
	REDIS_POOL_SIZE,
	REDIS_POOL_MIN_SIZE,
	REDIS_POOL_ACQUIRE_TIMEOUT,
	REDIS_POOL_IDLE_TIMEOUT,
	REDIS_KEEP_ALIVE,
	REDIS_CONNECT_TIMEOUT,
	REDIS_HOST,
	REDIS_PORT,
	REDIS_TLS,
} = Object.entries(env).reduce((acc: any, [k, v]) => {
	acc[k] = parseInt(v as string, 10) || v;
	return acc;
}, {});
// Password must stay as string, not coerced through parseInt ---------------------------
const REDIS_PASSWORD = env.REDIS_PASSWORD;
const REDIS_ENABLE_OFFLINE_QUEUE =
	process.env.REDIS_ENABLE_OFFLINE_QUEUE != null ? ['1', 'true', 'yes', 'on'].includes(String(process.env.REDIS_ENABLE_OFFLINE_QUEUE).trim().toLowerCase()) : process.env.NODE_ENV !== 'production';

// REDIS CLIENT CONFIG ----------------------------------------------------------
// Builds the ioredis connection options from env, including sentinel and TLS support.
// Also sets operational defaults (autoPipelining, offline queue behavior, timeouts).
// Steps: normalize env, build base options, optionally add TLS and sentinel config, return a single object passed to ioRedis constructor.
function getRedisConfig(): RedisOptions {
	const trimmedPassword = typeof REDIS_PASSWORD === 'string' ? REDIS_PASSWORD.trim() : REDIS_PASSWORD;
	const base: RedisOptions = {
		enableReadyCheck: true,
		keepAlive: REDIS_KEEP_ALIVE,
		// In production, buffering commands during outages can balloon memory and hide failures.
		// Default is fail-fast in production; enable explicitly if you truly want queueing.
		enableOfflineQueue: REDIS_ENABLE_OFFLINE_QUEUE,
		connectTimeout: REDIS_CONNECT_TIMEOUT,
		showFriendlyErrorStack: true,
		retryStrategy: (times: number) => Math.min(times * 100, 2000),
		reconnectOnError: (err: Error) => err.message.includes('READONLY'),
		maxRetriesPerRequest: 3,
		...(trimmedPassword ? { password: trimmedPassword } : {}),
	};
	if (REDIS_TLS) base.tls = {};
	if (env.REDIS_USE_SENTINEL) {
		const sentinels = String(process.env.REDIS_SENTINELS || env.REDIS_SENTINELS || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean)
			.map(s => {
				const [host, port] = s.split(':');
				return { host, port: Number(port) || 26379 };
			});

		const sentinelPassword = String(process.env.REDIS_SENTINEL_PASSWORD || env.REDIS_SENTINEL_PASSWORD || '').trim() || undefined;
		const sentinelConfig = {
			...base,
			sentinels,
			name: process.env.REDIS_SENTINEL_NAME || env.REDIS_SENTINEL_NAME || 'mymaster',
			sentinelPassword,
			role: 'master',
		};
		// NOTE: Sentinel config log removed - 20 workers x multiple connections = 40+ logs
		return sentinelConfig;
	}
	return {
		...base,
		port: Number(process.env.REDIS_PORT) || REDIS_PORT,
		host: process.env.REDIS_HOST || REDIS_HOST,
	};
}

export const Redis = {
	// GET CLIENT ----------------------------------------------------------------
	// Returns a ready, circuit-breaker-wrapped main client. Initializes on first use.
	async getClient() {
		if (redisClient && redisClient.status === 'ready') {
			// Return circuit-breaker wrapped client
			return createCircuitBreakerProxy(redisClient);
		}
		if (isInitializing && initPromise) {
			await initPromise;
			return createCircuitBreakerProxy(redisClient);
		}
		await initializeRedisClient();
		return createCircuitBreakerProxy(redisClient);
	},
	// ACQUIRE CONNECTION --------------------------------------------------------
	// Provides a pooled connection for bursty workloads where a single client may bottleneck.
	// Callers must release via releaseConnection() or use withConnection().
	async acquireConnection() {
		if (!isPoolInitialized) await initializeConnectionPool();
		// Never recurse here: repeated bad connections can blow the stack under flapping.
		while (availableConnections.length > 0) {
			const conn = availableConnections.pop();
			if (conn?.status === 'ready') return conn;
			connectionPool = connectionPool.filter(c => c !== conn);
			availableConnections = availableConnections.filter(c => c !== conn);
			try {
				await conn?.quit?.();
			} catch (e) {
				logger.alert('redis.quit_failed', { error: e?.message });
			}
			try {
				conn?.disconnect?.();
			} catch (e) {
				logger.alert('redis.disconnect_failed', { error: e?.message });
			}
		}
		if (connectionPool.length < REDIS_POOL_SIZE) {
			const conn = await createPoolConnection();
			connectionPool.push(conn);
			return conn;
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingAcquisitions = pendingAcquisitions.filter(p => p.reject !== reject);
				reject(new Error(`[redis-pool] Timeout after ${REDIS_POOL_ACQUIRE_TIMEOUT}ms`));
			}, REDIS_POOL_ACQUIRE_TIMEOUT);
			pendingAcquisitions.push({
				resolve: conn => {
					clearTimeout(timeout);
					resolve(conn);
				},
				reject,
				timestamp: Date.now(),
			});
		});
	},
	// RELEASE CONNECTION --------------------------------------------------------
	// Returns a pooled connection to the available list or hands it directly to a waiter.
	// Broken connections are evicted and replaced best-effort (never re-pooled).
	releaseConnection(conn) {
		if (!conn) return;
		// Never give a broken connection to a waiter or put it back into the pool.
		if (conn.status !== 'ready') {
			connectionPool = connectionPool.filter(c => c !== conn);
			availableConnections = availableConnections.filter(c => c !== conn);

			const maybeWakeWaiter = () => {
				if (pendingAcquisitions.length === 0) return;
				const { resolve } = pendingAcquisitions.shift();
				// Fire-and-forget replacement for the waiter (best effort).
				(async () => {
					try {
						const replacement = await createPoolConnection();
						connectionPool.push(replacement);
						resolve(replacement);
					} catch {
						// Leave waiter to timeout (better than handing out a broken conn).
					}
				})().catch(() => {});
			};

			try {
				conn.quit().catch(() => {});
			} catch (e) {
				logger.alert('redis.quit_failed_release', { error: e?.message });
			}
			try {
				conn.disconnect();
			} catch (e) {
				logger.alert('redis.disconnect_failed_release', { error: e?.message });
			}

			maybeWakeWaiter();
			return;
		}
		if (pendingAcquisitions.length > 0) {
			const { resolve } = pendingAcquisitions.shift();
			resolve(conn);
			return;
		}
		conn._lastUsed = Date.now(); // Track last use time for idle trimming ---------------------------
		availableConnections.push(conn);
	},
	// WITH CONNECTION -----------------------------------------------------------
	// Scoped helper to guarantee releaseConnection() even when cb throws.
	async withConnection(cb) {
		const conn = await this.acquireConnection();
		try {
			return await cb(conn);
		} finally {
			this.releaseConnection(conn);
		}
	},
	// SHUTDOWN ------------------------------------------------------------------
	// Gracefully closes pool + main client and clears module setters.
	async shutDown() {
		try {
			if (poolHealthCheckInterval) clearInterval(poolHealthCheckInterval), (poolHealthCheckInterval = null);
			if (connectionPool.length > 0) {
				logger.info('redis.pool_closing_connections', { connectionCount: connectionPool.length });
				await Promise.all(connectionPool.map(c => c.quit().catch(() => {})));
				connectionPool = availableConnections = pendingAcquisitions = [];
				isPoolInitialized = false;
			}
			if (redisClient) {
				logger.info('redis.closing_main_connection');
				if (healthCheckInterval) clearInterval(healthCheckInterval), (healthCheckInterval = null);
				await redisClient.quit();
				redisClient = null;
				connectionState = 'disconnected';
				clientSetters.forEach(s => s(null));
			}
			return { success: true, message: 'Redis connections closed' };
		} catch (err) {
			logger.error('redis.shutdown_error', { error: err });
			throw err;
		}
	},
	// CONNECTION STATE ----------------------------------------------------------
	// Exposes lightweight diagnostic info (used by admin diag endpoint).
	getConnectionState() {
		return { state: connectionState, status: redisClient?.status || 'none', poolSize: connectionPool.length, available: availableConnections.length, pending: pendingAcquisitions.length };
	},
};

// CREATE POOL CONNECTION -------------------------------------------------------
// Creates a single ioredis connection for the pool and resolves when it becomes ready.
async function createPoolConnection() {
	const conn = new ioRedis(getRedisConfig());
	conn.on('error', err => {
		logger.error('redis.pool_connection_error', { error: err });
		connectionPool = connectionPool.filter(c => c !== conn);
		availableConnections = availableConnections.filter(c => c !== conn);
		// Ensure the underlying socket is closed when evicting from pool.
		try {
			conn.disconnect();
		} catch (e) {
			logger.alert('redis.disconnect_failed', { error: e?.message });
		}
	});
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			try {
				conn.removeAllListeners('ready');
			} catch (e) {
				logger.alert('redis.remove_listener_failed', { error: e?.message });
			}
			try {
				conn.removeAllListeners('error');
			} catch (e) {
				logger.alert('redis.remove_listener_failed', { error: e?.message });
			}
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			cleanup();
			resolve(conn);
		};
		const finishReject = err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			cleanup();
			// Close socket on failure/timeout to avoid orphaned connections.
			try {
				conn.disconnect();
			} catch (e) {
				logger.alert('redis.disconnect_failed_reject', { error: e?.message });
			}
			reject(err);
		};
		conn.once('ready', finishResolve);
		conn.once('error', finishReject);
		const timeout = setTimeout(() => finishReject(new Error('[redis-pool] Conn timeout')), REDIS_CONNECT_TIMEOUT);
	});
}

// INITIALIZE CONNECTION POOL ---------------------------------------------------
// Bootstraps a minimum number of pooled connections and starts periodic health checks.
async function initializeConnectionPool() {
	if (isPoolInitialized) return;
	try {
		const conns = await Promise.all(Array(REDIS_POOL_MIN_SIZE).fill(undefined).map(createPoolConnection));
		connectionPool = [...conns];
		availableConnections = [...conns];
		poolHealthCheckInterval = setInterval(monitorPoolHealth, REDIS_HEALTH_CHECK_INTERVAL);
		isPoolInitialized = true;
		// NOTE: Removed pool ready log - redis.ready is sufficient
	} catch (err) {
		logger.error('redis.pool_init_failed', { error: err });
		for (const c of connectionPool) c.quit().catch(() => {});
		connectionPool = availableConnections = [];
		throw err;
	}
}

// POOL HEALTH MONITOR ----------------------------------------------------------
// Reclaims timed-out acquisitions, trims idle connections, and replaces unhealthy ones.
function monitorPoolHealth() {
	const now = Date.now();
	// Reject timed-out acquisitions before filtering them out ---------------------------
	const timedOut = pendingAcquisitions.filter(p => now - p.timestamp > REDIS_POOL_ACQUIRE_TIMEOUT);
	for (const p of timedOut) p.reject(new Error(`[redis-pool] Timeout after ${REDIS_POOL_ACQUIRE_TIMEOUT}ms`));
	pendingAcquisitions = pendingAcquisitions.filter(p => now - p.timestamp <= REDIS_POOL_ACQUIRE_TIMEOUT);
	// Trim idle connections with timeout (not aggressively on every release) ---------------------------
	if (connectionPool.length > REDIS_POOL_MIN_SIZE && availableConnections.length > REDIS_POOL_MIN_SIZE) {
		const idleConns = availableConnections.filter(c => c._lastUsed && now - c._lastUsed > REDIS_POOL_IDLE_TIMEOUT).slice(0, availableConnections.length - REDIS_POOL_MIN_SIZE);
		for (const c of idleConns) {
			availableConnections = availableConnections.filter(x => x !== c);
			connectionPool = connectionPool.filter(x => x !== c);
			c.quit().catch(err => logger.error('redis.pool_close_idle_failed', { error: err }));
		}
	}
	// Replace unhealthy connections ---------------------------
	for (let i = connectionPool.length - 1; i >= 0; i--) {
		const conn = connectionPool[i];
		if (conn.status !== 'ready') {
			logger.alert('redis.pool_removing_unhealthy_connection', { status: conn.status });
			connectionPool.splice(i, 1);
			availableConnections = availableConnections.filter(c => c !== conn);
			// Ensure socket is closed when removing a bad connection.
			conn.quit()
				.catch(() => {})
				.finally(() => {
					try {
						conn.disconnect();
					} catch (e) {
						logger.alert('redis.disconnect_failed_monitor', { error: e?.message });
					}
				});

			// Serialize replacements to avoid stampedes under flapping conditions.
			poolReplacementChain = poolReplacementChain
				.then(() =>
					createPoolConnection().then(newConn => {
						connectionPool.push(newConn);
						if (pendingAcquisitions.length > 0) pendingAcquisitions.shift().resolve(newConn);
						else availableConnections.push(newConn);
					})
				)
				.catch(err => logger.error('redis.pool_replacement_failed', { error: err }));
		}
	}
}

// MAIN CLIENT INITIALIZATION ---------------------------------------------------
// Establishes the shared main redis client with retry loop and installs module setters.
// Also triggers pool initialization in the background once connected.
export async function initializeRedisClient() {
	if (isInitializing) return initPromise;
	isInitializing = true;
	initPromise = new Promise<void>((resolve, reject) => {
		let attempts = 0;
		const connect = () => {
			if (attempts >= REDIS_MAX_ATTEMPTS) {
				connectionState = 'disconnected';
				reject(new Error(`Failed after ${REDIS_MAX_ATTEMPTS} attempts`));
				return;
			}
			attempts++;
			// NOTE: Removed per-attempt logs - only log on success or final failure
			redisClient = new ioRedis(getRedisConfig());
			redisClient.on('error', err => logger.error('redis.client_error', { error: err }));
			redisClient.on('connect', () => connectionState = 'connected');
			redisClient.on('ready', () => {
				connectionState = 'connected';
				const wrappedClient = createCircuitBreakerProxy(redisClient);
				clientSetters.forEach(s => { try { s(wrappedClient); } catch (err) { logger.error('redis.setter_error', { error: err }); } });
				if (!healthCheckInterval) healthCheckInterval = setInterval(() => {
					if (redisClient && redisClient.status !== 'ready') logger.alert('redis.not_ready', { status: redisClient.status });
				}, REDIS_HEALTH_CHECK_INTERVAL);
			});
			redisClient.on('end', () => {
				connectionState = 'disconnected';
				if (healthCheckInterval) clearInterval(healthCheckInterval), (healthCheckInterval = null);
				replaceRedisClient();
			});
			redisClient.once('ready', () => resolve());
			redisClient.once('error', err => {
				logger.error('redis.connect_attempt_failed', { error: err, attempt: attempts });
				if (redisClient) redisClient.quit().catch(() => {}), (redisClient = null);
				setTimeout(connect, REDIS_ATTEMPT_DELAY * attempts);
			});
		};
		connect();
	});
	try {
		await initPromise;
		initializeConnectionPool().catch(err => logger.error('redis.pool_init_failed', { error: err }));
		reportSubsystemReady('REDIS');
	} finally {
		isInitializing = false;
		initPromise = null;
	}
}

// CLIENT REPLACEMENT -----------------------------------------------------------
// Swaps out a dead main client and re-initializes. Serialized to avoid stampedes.
async function replaceRedisClient() {
	if (isInitializing) return;
	logger.info('redis.replacing_client');
	if (redisClient) await redisClient.quit().catch(() => {}), (redisClient = null), clientSetters.forEach(s => s(null));
	await initializeRedisClient();
}

// Shutdown handlers are in cluster/worker.js - avoid duplicate handlers that call process.exit() ---------------------------
