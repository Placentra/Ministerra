// IOREDIS IMPORT (ESM SAFE) ----------------------------------------------------
// ioredis is CommonJS; under Node ESM it does not expose runtime named exports reliably.
// Use default import for runtime, and `import type` for types so TS doesn't emit runtime imports.
import IoRedis from 'ioredis';
import type { RedisOptions, Redis as ioRedisType } from 'ioredis';
import os from 'os';
import { isMainThread } from 'worker_threads';
import { getLogger } from '../handlers/loggers.ts';
import { createCircuitBreaker } from '../handlers/circuitBreaker.ts';
import { reportSubsystemReady } from '../../cluster/readiness.ts';

const logger = getLogger('Redis');

// CIRCUIT BREAKER --------------------------------------------------------------
// Guards Redis commands so transient outages don't turn into unbounded request hangs.
// The breaker is used by proxy-wrapping the ioredis client and recording command latency/failures.
// Steps: fail fast under outage, then gradually recover when Redis stabilizes; prevents request handlers from piling up behind slow/hung commands.
const redisCircuitBreaker = createCircuitBreaker('Redis', {
	failureThreshold: 5,
	timeoutMs: 5000, // 5s timeout for Redis operations
	cooldownMs: 30000, // Try again after 30s
});

// CIRCUIT BREAKER PROXY --------------------------------------------------------
// Wraps Redis commands with circuit breaker execute() while excluding connection-management APIs.
// Note: pipeline()/multi() are intentionally NOT wrapped because they return non-promise builder objects.
// Steps: proxy-wrap only promise-returning redis commands, route them through breaker.execute(), and leave builder/connection APIs untouched.
function createCircuitBreakerProxy(client: any): any {
	// Commands that should NOT be wrapped (connection management or non-promise APIs)
	const skipCommands: Set<string> = new Set([
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
		get(target: any, prop: string | symbol) {
			const value: any = target[prop];

			// Skip non-command properties
			if (typeof value !== 'function' || typeof prop !== 'string' || skipCommands.has(prop)) {
				return value;
			}

			// Wrap command with circuit breaker
			return function (...args: any[]) {
				// For some operations like multi(), return the original (it returns a Pipe object)
				if (prop === 'multi' || prop === 'pipeline') {
					return value.apply(target, args);
				}

				// Wrap command execution with circuit breaker
				return redisCircuitBreaker.execute(
					async (): Promise<any> => {
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

let redisClient: ioRedisType | null = null,
	connectionState: string = 'disconnected',
	isInitializing: boolean = false,
	initPromise: Promise<void> | null = null,
	healthCheckInterval: any = null,
	poolHealthCheckInterval: any = null;
let connectionPool: ioRedisType[] = [],
	availableConnections: ioRedisType[] = [],
	// eslint-disable-next-line no-unused-vars -- Type-only callback args are required for readability; they are never referenced at runtime.
	pendingAcquisitions: { resolve: (redisConnection: ioRedisType) => void; reject: (rejectionError: Error) => void; timestamp: number }[] = [],
	isPoolInitialized: boolean = false;

// Serialize pool replacements to avoid stampedes under flapping conditions.
let poolReplacementChain: Promise<void> = Promise.resolve();

// REDIS CLIENT SETTERS (MAIN THREAD ONLY) --------------------------------------
// These setters wire the global redis client into many modules.
// Importing all those modules at top-level creates a huge dependency graph that can
// deadlock module evaluation inside worker_threads. Load them dynamically ONLY in
// the main thread.
let clientSetters: ((redisClientInstance: any) => any)[] = [];
let clientSettersLoadPromise: Promise<void> | null = null;

// LOAD SETTERS -----------------------------------------------------------------
// Steps: in worker_threads, do nothing; in main thread, dynamically import each module
// and extract its `ioRedisSetter` export if present.
async function ensureRedisClientSettersLoaded(): Promise<void> {
	// WORKER THREAD GUARD -------------------------------------------------------
	// Worker threads must not import the entire application module graph.
	if (!isMainThread) return;

	// DEDUP LOAD ----------------------------------------------------------------
	if (clientSettersLoadPromise) return await clientSettersLoadPromise;

	clientSettersLoadPromise = (async () => {
		const setters: ((redisClientInstance: any) => any)[] = [];
		const importTargets: { label: string; path: string }[] = [
			{ label: 'alerts', path: '../../modules/alerts.ts' },
			{ label: 'chat', path: '../../modules/chat.ts' },
			{ label: 'content', path: '../../modules/content.ts' },
			{ label: 'discussion', path: '../../modules/discussion.ts' },
			{ label: 'editor', path: '../../modules/editor/index.ts' },
			{ label: 'entrance', path: '../../modules/entrance/index.ts' },
			{ label: 'event', path: '../../modules/event.ts' },
			{ label: 'foundation', path: '../../modules/foundation.ts' },
			{ label: 'interests', path: '../../modules/interests.ts' },
			{ label: 'jwtokens', path: '../../modules/jwtokens.ts' },
			{ label: 'rating', path: '../../modules/rating.ts' },
			{ label: 'user', path: '../../modules/user.ts' },
			{ label: 'setup', path: '../../modules/setup/index.ts' },
			{ label: 'socket', path: '../../systems/socket/socket.ts' },
			{ label: 'contentFilters', path: '../../utilities/contentFilters.ts' },
			{ label: 'contentHelpers', path: '../../utilities/contentHelpers.ts' },
			{ label: 'cache', path: '../../utilities/helpers/cache.ts' },
			{ label: 'location', path: '../../utilities/helpers/location.ts' },
			{ label: 'chatHandlers', path: '../../systems/socket/chatHandlers.ts' },
			{ label: 'invites', path: '../../modules/invites.ts' },
			{ label: 'locations', path: '../../modules/locations.ts' },
			{ label: 'quickQueries', path: '../../modules/chat/quickQueries.ts' },
		];

		// DYNAMIC IMPORTS --------------------------------------------------------
		// Best-effort: a missing setter should not break Redis init.
		for (const importTarget of importTargets) {
			try {
				const importedModule: any = await import(importTarget.path);
				const ioRedisSetter: any = importedModule?.ioRedisSetter;
				if (typeof ioRedisSetter === 'function') setters.push(ioRedisSetter);
			} catch (error: any) {
				logger.alert('redis.setter_import_failed', { module: importTarget.label, error: error?.message || String(error) });
			}
		}

		clientSetters = setters;
		logger.info('redis.setters_loaded', { count: clientSetters.length });
	})().finally(() => {
		// Allow a later retry if something failed catastrophically.
		clientSettersLoadPromise = null;
	});

	return await clientSettersLoadPromise;
}
// POOL SIZING -------------------------------------------------------------------
// Keep per-process pool small (2-8). ioredis pipelines commands and large pools rarely help.
// In clustered mode, total connections scale by worker process count.
const CPU_COUNT = Math.max(1, os.cpus().length);
const IS_SINGLE_PROCESS_MODE = process.env.MIN_MODE === '1' || process.env.SWARM_MODE === '1';
const EFFECTIVE_PROCESS_COUNT = IS_SINGLE_PROCESS_MODE ? 1 : CPU_COUNT;
const CALCULATED_POOL_SIZE = Math.min(8, Math.max(2, Math.floor(16 / EFFECTIVE_PROCESS_COUNT)));
const env = {
	REDIS_MAX_ATTEMPTS: Number(process.env.REDIS_MAX_ATTEMPTS) || 5,
	REDIS_ATTEMPT_DELAY: Number(process.env.REDIS_ATTEMPT_DELAY) || 1000,
	REDIS_HEALTH_CHECK_INTERVAL: Number(process.env.REDIS_HEALTH_CHECK_INTERVAL) || 10000,
	REDIS_POOL_SIZE: Number(process.env.REDIS_POOL_SIZE) || CALCULATED_POOL_SIZE,
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
		const sentinelConfig: RedisOptions = {
			...base,
			sentinels,
			name: process.env.REDIS_SENTINEL_NAME || env.REDIS_SENTINEL_NAME || 'mymaster',
			sentinelPassword,
			role: 'master' as const, // ioredis sentinel typing requires 'master' | 'slave' (avoid TS widening to string)
		};
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
	async getClient(): Promise<any> {
		if (redisClient && (redisClient as any).status === 'ready') {
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
	async acquireConnection(): Promise<ioRedisType> {
		if (!isPoolInitialized) await initializeConnectionPool();
		// Never recurse here: repeated bad connections can blow the stack under flapping.
		while (availableConnections.length > 0) {
			const conn: ioRedisType | undefined = availableConnections.pop();
			if (conn && (conn as any).status === 'ready') return conn;
			if (conn) {
				connectionPool = connectionPool.filter(c => c !== conn);
				availableConnections = availableConnections.filter(c => c !== conn);
				try {
					await (conn as any).quit?.();
				} catch (e: any) {
					logger.alert('redis.quit_failed', { error: e?.message });
				}
				try {
					(conn as any).disconnect?.();
				} catch (e: any) {
					logger.alert('redis.disconnect_failed', { error: e?.message });
				}
			}
		}
		if (connectionPool.length < REDIS_POOL_SIZE) {
			const conn: ioRedisType = await createPoolConnection();
			connectionPool.push(conn);
			return conn;
		}
		return new Promise<ioRedisType>((resolve, reject) => {
			// ACQUIRE TIMEOUT ---------------------------------------------------------
			// Avoid `NodeJS.Timeout` namespace to keep eslint `no-undef` happy in TS type positions.
			const acquireTimeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
				pendingAcquisitions = pendingAcquisitions.filter(p => p.reject !== reject);
				reject(new Error(`[redis-pool] Timeout after ${REDIS_POOL_ACQUIRE_TIMEOUT}ms`));
			}, REDIS_POOL_ACQUIRE_TIMEOUT);
			pendingAcquisitions.push({
				resolve: (conn: ioRedisType): void => {
					clearTimeout(acquireTimeoutHandle);
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
	releaseConnection(conn: ioRedisType | null | undefined): void {
		if (!conn) return;
		// Never give a broken connection to a waiter or put it back into the pool.
		if ((conn as any).status !== 'ready') {
			connectionPool = connectionPool.filter(c => c !== conn);
			availableConnections = availableConnections.filter(c => c !== conn);

			const maybeWakeWaiter = (): void => {
				if (pendingAcquisitions.length === 0) return;
				const acquisition: any = pendingAcquisitions.shift();
				if (!acquisition) return;
				const { resolve }: any = acquisition;
				// Fire-and-forget replacement for the waiter (best effort).
				(async () => {
					try {
						const replacement: ioRedisType = await createPoolConnection();
						connectionPool.push(replacement);
						resolve(replacement);
					} catch {
						// Leave waiter to timeout (better than handing out a broken conn).
					}
				})().catch(() => {});
			};

			try {
				(conn as any).quit().catch(() => {});
			} catch (e: any) {
				logger.alert('redis.quit_failed_release', { error: e?.message });
			}
			try {
				(conn as any).disconnect();
			} catch (e: any) {
				logger.alert('redis.disconnect_failed_release', { error: e?.message });
			}

			maybeWakeWaiter();
			return;
		}
		if (pendingAcquisitions.length > 0) {
			const acquisition: any = pendingAcquisitions.shift();
			if (acquisition) {
				const { resolve }: any = acquisition;
				resolve(conn);
			}
			return;
		}
		(conn as any)._lastUsed = Date.now(); // Track last use time for idle trimming ---------------------------
		availableConnections.push(conn);
	},
	// WITH CONNECTION -----------------------------------------------------------
	// Scoped helper to guarantee releaseConnection() even when cb throws.
	// eslint-disable-next-line no-unused-vars -- Type-only callback signature; parameter name is not referenced here.
	async withConnection<T>(cb: (redisConnection: ioRedisType) => Promise<T>): Promise<T> {
		const conn: ioRedisType = await this.acquireConnection();
		try {
			return await cb(conn);
		} finally {
			this.releaseConnection(conn);
		}
	},
	// SHUTDOWN ------------------------------------------------------------------
	// Gracefully closes pool + main client and clears module setters.
	async shutDown(): Promise<{ success: boolean; message: string }> {
		try {
			if (poolHealthCheckInterval) clearInterval(poolHealthCheckInterval), (poolHealthCheckInterval = null);
			if (connectionPool.length > 0) {
				logger.info('redis.pool_closing_connections', { connectionCount: connectionPool.length });
				await Promise.all(connectionPool.map((c: ioRedisType) => (c as any).quit().catch(() => {})));
				connectionPool = [];
				availableConnections = [];
				pendingAcquisitions = [];
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
		} catch (err: any) {
			logger.error('redis.shutdown_error', { error: err });
			throw err;
		}
	},
	// CONNECTION STATE ----------------------------------------------------------
	// Exposes lightweight diagnostic info (used by admin diag endpoint).
	getConnectionState(): { state: string; status: string; poolSize: number; available: number; pending: number } {
		return { state: connectionState, status: (redisClient as any)?.status || 'none', poolSize: connectionPool.length, available: availableConnections.length, pending: pendingAcquisitions.length };
	},
};

// CREATE POOL CONNECTION -------------------------------------------------------
// Creates a single ioredis connection for the pool and resolves when it becomes ready.
async function createPoolConnection(): Promise<ioRedisType> {
	const conn: ioRedisType = new IoRedis(getRedisConfig());
	conn.on('error', (err: Error) => {
		logger.error('redis.pool_connection_error', { error: err });
		connectionPool = connectionPool.filter(c => c !== conn);
		availableConnections = availableConnections.filter(c => c !== conn);
		// Ensure the underlying socket is closed when evicting from pool.
		try {
			(conn as any).disconnect();
		} catch (e: any) {
			logger.alert('redis.disconnect_failed', { error: e?.message });
		}
	});
	return new Promise<ioRedisType>((resolve, reject) => {
		let settled: boolean = false;
		// READY TIMEOUT ------------------------------------------------------------
		// Avoid `NodeJS.Timeout` namespace to keep eslint `no-undef` happy in TS type positions.
		let connectionReadyTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
		const cleanup = (): void => {
			try {
				conn.removeAllListeners('ready');
			} catch (e: any) {
				logger.alert('redis.remove_listener_failed', { error: e?.message });
			}
			try {
				conn.removeAllListeners('error');
			} catch (e: any) {
				logger.alert('redis.remove_listener_failed', { error: e?.message });
			}
		};
		const finishResolve = (): void => {
			if (settled) return;
			settled = true;
			if (connectionReadyTimeoutHandle) clearTimeout(connectionReadyTimeoutHandle);
			cleanup();
			resolve(conn);
		};
		const finishReject = (err: Error): void => {
			if (settled) return;
			settled = true;
			if (connectionReadyTimeoutHandle) clearTimeout(connectionReadyTimeoutHandle);
			cleanup();
			// Close socket on failure/timeout to avoid orphaned connections.
			try {
				(conn as any).disconnect();
			} catch (e: any) {
				logger.alert('redis.disconnect_failed_reject', { error: e?.message });
			}
			reject(err);
		};
		conn.once('ready', finishResolve);
		conn.once('error', finishReject);
		connectionReadyTimeoutHandle = setTimeout(() => finishReject(new Error('[redis-pool] Conn timeout')), REDIS_CONNECT_TIMEOUT);
	});
}

// INITIALIZE CONNECTION POOL ---------------------------------------------------
// Bootstraps a minimum number of pooled connections and starts periodic health checks.
async function initializeConnectionPool(): Promise<void> {
	if (isPoolInitialized) return;
	try {
		const conns: ioRedisType[] = await Promise.all(Array(REDIS_POOL_MIN_SIZE).fill(undefined).map(createPoolConnection));
		connectionPool = [...conns];
		availableConnections = [...conns];
		poolHealthCheckInterval = setInterval(monitorPoolHealth, REDIS_HEALTH_CHECK_INTERVAL);
		isPoolInitialized = true;
	} catch (err: any) {
		logger.error('redis.pool_init_failed', { error: err });
		for (const c of connectionPool) (c as any).quit().catch(() => {});
		connectionPool = [];
		availableConnections = [];
		throw err;
	}
}

// POOL HEALTH MONITOR ----------------------------------------------------------
// Reclaims timed-out acquisitions, trims idle connections, and replaces unhealthy ones.
function monitorPoolHealth(): void {
	const now: number = Date.now();
	// Reject timed-out acquisitions before filtering them out ---------------------------
	const timedOut: any[] = pendingAcquisitions.filter(p => now - p.timestamp > REDIS_POOL_ACQUIRE_TIMEOUT);
	for (const p of timedOut) p.reject(new Error(`[redis-pool] Timeout after ${REDIS_POOL_ACQUIRE_TIMEOUT}ms`));
	pendingAcquisitions = pendingAcquisitions.filter(p => now - p.timestamp <= REDIS_POOL_ACQUIRE_TIMEOUT);
	// Trim idle connections with timeout (not aggressively on every release) ---------------------------
	if (connectionPool.length > REDIS_POOL_MIN_SIZE && availableConnections.length > REDIS_POOL_MIN_SIZE) {
		const idleConns: ioRedisType[] = availableConnections
			.filter((c: any) => c._lastUsed && now - c._lastUsed > REDIS_POOL_IDLE_TIMEOUT)
			.slice(0, availableConnections.length - REDIS_POOL_MIN_SIZE);
		for (const c of idleConns) {
			availableConnections = availableConnections.filter(x => x !== c);
			connectionPool = connectionPool.filter(x => x !== c);
			(c as any).quit().catch((err: any) => logger.error('redis.pool_close_idle_failed', { error: err }));
		}
	}
	// Replace unhealthy connections ---------------------------
	for (let i: number = connectionPool.length - 1; i >= 0; i--) {
		const conn: any = connectionPool[i];
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
					} catch (e: any) {
						logger.alert('redis.disconnect_failed_monitor', { error: e?.message });
					}
				});

			// Serialize replacements to avoid stampedes under flapping conditions.
			poolReplacementChain = poolReplacementChain
				.then(() =>
					createPoolConnection().then((newConn: ioRedisType) => {
						connectionPool.push(newConn);
						const acquisition: any = pendingAcquisitions.shift();
						if (acquisition) acquisition.resolve(newConn);
						else availableConnections.push(newConn);
					})
				)
				.catch((err: any) => logger.error('redis.pool_replacement_failed', { error: err }));
		}
	}
}

// MAIN CLIENT INITIALIZATION ---------------------------------------------------
// Establishes the shared main redis client with retry loop and installs module setters.
// Also triggers pool initialization in the background once connected.
export async function initializeRedisClient(): Promise<void> {
	if (isInitializing) return initPromise as any;
	isInitializing = true;
	initPromise = new Promise<void>((resolve, reject) => {
		let attempts: number = 0;
		const connect = (): void => {
			if (attempts >= REDIS_MAX_ATTEMPTS) {
				connectionState = 'disconnected';
				reject(new Error(`Failed after ${REDIS_MAX_ATTEMPTS} attempts`));
				return;
			}
			attempts++;
			redisClient = new IoRedis(getRedisConfig());
			redisClient.on('error', (err: Error) => logger.error('redis.client_error', { error: err }));
			redisClient.on('connect', () => (connectionState = 'connected'));
			redisClient.on('ready', () => {
				connectionState = 'connected';
				const wrappedClient: any = createCircuitBreakerProxy(redisClient);

				// SETTER WIRING ------------------------------------------------------
				// Load setters lazily in main thread only; avoid worker_threads import graph.
				ensureRedisClientSettersLoaded()
					.then(() => {
						clientSetters.forEach(setterFunction => {
							try {
								setterFunction(wrappedClient);
							} catch (error: any) {
								logger.error('redis.setter_error', { error });
							}
						});
					})
					.catch((error: any) => logger.error('redis.setter_load_failed', { error }));

				if (!healthCheckInterval)
					healthCheckInterval = setInterval(() => {
						if (redisClient && (redisClient as any).status !== 'ready') logger.alert('redis.not_ready', { status: (redisClient as any).status });
					}, REDIS_HEALTH_CHECK_INTERVAL);
			});
			redisClient.on('end', () => {
				connectionState = 'disconnected';
				if (healthCheckInterval) clearInterval(healthCheckInterval), (healthCheckInterval = null);
				replaceRedisClient();
			});
			redisClient.once('ready', () => resolve());
			redisClient.once('error', (err: Error) => {
				logger.error('redis.connect_attempt_failed', { error: err, attempt: attempts });
				if (redisClient) (redisClient as any).quit().catch(() => {}), (redisClient = null);
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
async function replaceRedisClient(): Promise<void> {
	if (isInitializing) return;
	logger.info('redis.replacing_client');
	if (redisClient) await (redisClient as any).quit().catch(() => {}), (redisClient = null), clientSetters.forEach(s => s(null));
	await initializeRedisClient();
}
