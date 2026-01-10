import mySQL from 'mysql2';
import cron from 'node-cron';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import fs from 'fs';
import fsp from 'fs/promises';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { spawn } from 'child_process';
import { Catcher } from '../systems.ts';
import { getLogger } from '../handlers/loggers.ts';
import os from 'os';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createCircuitBreaker } from '../handlers/circuitBreaker.ts';
import { reportSubsystemReady } from '../../cluster/readiness.ts';
dotenv.config();

// LOGGER SETUP -----------------------------------------------------------------
// Steps: keep SQL-layer logs under one label so callsites are consistent and log filters stay stable.
const sqlLogger = getLogger('SQL');

// MYSQL SYSTEMS LAYER ----------------------------------------------------------
// Steps: centralize pool creation, read-splitting routing, breaker timeouts/slow-query policy, health checks, and ops helpers (backup/restore) so callsites stay simple and consistent.

// PROD SAFETY DEFAULTS ---------------------------------------------------------
// Steps: fail fast on missing env vars in prod (so misconfig is obvious), then let warmup/healthcheck validate connectivity later.
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const requireInProd = keys => {
	if (!isProd) return;
	const missing = keys.filter(k => !process.env[k] || String(process.env[k]).trim().length === 0);
	if (missing.length) throw new Error(`Missing required DB env vars: ${missing.join(', ')}`);
};
requireInProd(['HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME']);

// Get the backend root directory (two levels up from this file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '../..');

// RESOLVE BACKEND-ROOT PATH ----------------------------------------------------
// Steps: keep env paths stable even when CWD changes by resolving relative paths against BACKEND_ROOT.
const resolveFromBackendRoot = target => (path.isAbsolute(target) ? target : path.resolve(BACKEND_ROOT, target));

// BACKUP BASE DIR --------------------------------------------------------------
// Steps: keep backup output rooted under backend dir by default; allow env override to relocate to mounted volumes.
const BACKUP_BASE_DIR = resolveFromBackendRoot(process.env.DB_BACKUPS_PATH || 'databaseBackups');

// LIGHT MODE -------------------------------------------------------------------
// Steps: treat LIGHT_MODE as an ops knob to reduce background work; here it mainly stretches healthcheck cadence.
const LIGHT_MODE = process.env.LIGHT_MODE === '1';

/**
 * -----------------------------------------------------------------------------
 * POOL CONFIG (PRIMARY)
 * -----------------------------------------------------------------------------
 *
 * Required env:
 * - HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
 *
 * Capacity knobs:
 * - DB_POOL_LIMIT: max connections in the pool (default derived from CPU count)
 * - DB_POOL_QUEUE_LIMIT: max queued waiters when pool is exhausted (0 = unlimited)
 *
 * Defensive defaults:
 * - multipleStatements: false (prevents stacked statement injection)
 * - namedPlaceholders: true (supports mysql2 named params `:name`)
 * - bigNumberStrings/dateStrings: avoids JS precision/Date coercion surprises
 */
// POOL SIZING -------------------------------------------------------------------
// Each Node process creates TWO pools (primary + replica) even when read splitting is disabled.
// In clustered mode, every worker process does this independently.
// So total potential MySQL connections ~= workers × poolsPerWorker(2) × connectionLimit.
// Default MySQL `max_connections` is commonly ~151; this code MUST stay conservative by default.
const CPU_COUNT = Math.max(1, os.cpus().length);
const IS_SINGLE_PROCESS_MODE = process.env.MIN_MODE === '1' || process.env.SWARM_MODE === '1';
const EFFECTIVE_PROCESS_COUNT = IS_SINGLE_PROCESS_MODE ? 1 : CPU_COUNT;
const POOLS_PER_PROCESS = 2;

// DEFAULT CONNECTION LIMIT ------------------------------------------------------
// Keep the default total connection budget around ~80 per instance so we don't overload a default MySQL install.
// Example (8 workers): per-pool limit = floor(40 / 8) clamped -> 5, total ~= 8×2×5 = 80.
// TOTAL CONNECTION BUDGET ------------------------------------------------------
// Budget is split across all processes and across both pools (primary+replica).
// total ~= processes × poolsPerProcess × perPoolLimit
const TOTAL_CONNECTION_BUDGET = 80;
const CALCULATED_POOL_LIMIT = Math.min(20, Math.max(4, Math.floor(TOTAL_CONNECTION_BUDGET / (EFFECTIVE_PROCESS_COUNT * POOLS_PER_PROCESS))));
const DEFAULT_POOL_LIMIT = Number(process.env.DB_POOL_LIMIT) || CALCULATED_POOL_LIMIT;

// DEFAULT QUEUE LIMIT -----------------------------------------------------------
// queueLimit=0 means unbounded waiters -> memory growth under DB outage/pool exhaustion.
// Keep bounded by default; raise explicitly if needed.
const DEFAULT_QUEUE_LIMIT = process.env.DB_POOL_QUEUE_LIMIT !== undefined ? Number(process.env.DB_POOL_QUEUE_LIMIT) : 1000;

// TLS/SSL OPTIONS --------------------------------------------------------------
// Steps: when enabled, read TLS materials from disk, fail fast in prod on unreadable materials, otherwise continue (non-prod) so dev doesn’t brick.
interface SslOptions {
	rejectUnauthorized: boolean;
	ca?: Buffer;
	cert?: Buffer;
	key?: Buffer;
}

const buildSslOptions = (): SslOptions | undefined => {
	if (process.env.DB_SSL !== '1') return undefined;
	const rejectUnauthorized: boolean = process.env.DB_SSL_REJECT_UNAUTHORIZED ? process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' : true;
	const ssl: SslOptions = { rejectUnauthorized };
	const caPath: string | undefined = process.env.DB_SSL_CA_PATH;
	const certPath: string | undefined = process.env.DB_SSL_CERT_PATH;
	const keyPath: string | undefined = process.env.DB_SSL_KEY_PATH;
	try {
		if (caPath) ssl.ca = fs.readFileSync(caPath);
		if (certPath) ssl.cert = fs.readFileSync(certPath);
		if (keyPath) ssl.key = fs.readFileSync(keyPath);
	} catch (e: any) {
		// Fail fast in prod if TLS is requested but materials are unreadable.
		if (isProd) throw new Error(`DB SSL material read failed: ${e.message}`);
		sqlLogger.alert('DB SSL material read failed (continuing in non-prod)', { error: e.message });
	}
	return ssl;
};
const sslOptions = buildSslOptions();

const config = {
	host: process.env.HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME,
	waitForConnections: true,
	multipleStatements: false,
	connectionLimit: DEFAULT_POOL_LIMIT,
	queueLimit: Number.isFinite(DEFAULT_QUEUE_LIMIT) && DEFAULT_QUEUE_LIMIT >= 0 ? DEFAULT_QUEUE_LIMIT : 0,
	connectTimeout: 15000,
	idleTimeout: 0, // WORKAROUND: Disabled to prevent Node 25 + mysql2 blocking hang on connection cleanup
	maxIdle: Math.min(20, Math.max(5, Math.floor(DEFAULT_POOL_LIMIT / 4))),
	enableKeepAlive: true,
	keepAliveInitialDelay: 30000,
	decimalNumbers: true,
	namedPlaceholders: true,
	dateStrings: true,
	supportBigNumbers: true,
	bigNumberStrings: true,
	charset: 'utf8mb4',
	timezone: '+00:00',
	...(sslOptions ? { ssl: sslOptions } : null),
};

// POOL CONFIG (REPLICA / READ) -------------------------------------------------
// Steps: allow read-pool env overrides; default to primary config so dev remains simple and read split can be enabled without special config.
const readConfig = {
	...config,
	host: process.env.DB_READ_HOST || config.host,
	port: process.env.DB_READ_PORT || config.port,
	user: process.env.DB_READ_USER || config.user,
	password: process.env.DB_READ_PASS || config.password,
	database: process.env.DB_READ_NAME || config.database,
};

// READ SPLITTING ---------------------------------------------------------------
// Steps: enable only when explicitly requested; start disabled until warmup passes so early boot traffic doesn’t hit a half-ready replica.
const READ_SPLIT_REQUESTED = process.env.DB_READ_SPLIT === '1'; // safer default: off unless explicitly enabled
let readSplitEnabled = READ_SPLIT_REQUESTED;
const READ_FAILBACK_MS = Number(process.env.DB_READ_FAILBACK_MS || 30000);
const READABLE_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];
const FORCE_PRIMARY_HINT = '/*force_primary*/';
const FORCE_REPLICA_HINT = '/*force_replica*/';

/**
 * Replica warmup config:
 * - Warmup is a "gate" that keeps `readSplitEnabled=false` until the replica can
 *   successfully answer a trivial query.
 *
 * Why: replica containers and/or MySQL replication setup can take time; routing
 * live traffic before it is ready causes flaky read paths.
 */
const READ_WARMUP_TABLE = process.env.DB_READ_WARMUP_TABLE?.trim();
const READ_WARMUP_SQL = process.env.DB_READ_WARMUP_SQL?.trim();
const READ_WARMUP_DELAY_MS = Number(process.env.DB_READ_WARMUP_DELAY_MS || 10000);
const READ_WARMUP_RETRY_MS = Number(process.env.DB_READ_WARMUP_RETRY_MS || 15000);
const READ_WARMUP_MAX_ATTEMPTS = Number(process.env.DB_READ_WARMUP_MAX_ATTEMPTS || 60);

// Promisify pipeline for async usage (stream pipeline -> Promise)
const pipelineAsync = promisify(pipeline);

/**
 * -----------------------------------------------------------------------------
 * CIRCUIT BREAKERS + SLOW QUERY POLICY
 * -----------------------------------------------------------------------------
 *
 * These values feed into `createCircuitBreaker` instrumentation for both pools.
 * The breaker is used to:
 * - enforce timeouts around pool operations
 * - detect & rate-limit slow query bursts
 * - open circuit on repeated failures
 */
const SLOW_SQL_MS = Number(process.env.SLOW_SQL_MS || 150);
const SQL_LOG_MAX_CHARS = Number(process.env.DB_SLOW_SQL_LOG_LIMIT || 800);
const DEFAULT_SLOW_BURST = Number(process.env.DB_SLOW_QUERY_BURST || 5);
const DEFAULT_SLOW_WINDOW_MS = Number(process.env.DB_SLOW_QUERY_WINDOW_MS || 10000);
const DEFAULT_SLOW_COOLDOWN_MS = Number(process.env.DB_SLOW_QUERY_COOLDOWN_MS || 30000);
const DEFAULT_QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 15000);
const DEFAULT_REPLICA_TIMEOUT_MS = Number(process.env.DB_REPLICA_QUERY_TIMEOUT_MS || DEFAULT_QUERY_TIMEOUT_MS);

// BREAKER OPTIONS --------------------------------------------------------------
// Steps: build one options object so primary/replica breakers share defaults; replica overrides are applied later to fail faster and cool down differently.
const createBreakerOptions = (overrides = null) => ({
	failureThreshold: overrides?.failureThreshold ?? 5,
	timeoutMs: overrides?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
	cooldownMs: overrides?.cooldownMs ?? DEFAULT_SLOW_COOLDOWN_MS,
	slowThresholdMs: overrides?.slowThresholdMs ?? SLOW_SQL_MS,
	slowBurst: overrides?.slowBurst ?? DEFAULT_SLOW_BURST,
	slowWindowMs: overrides?.slowWindowMs ?? DEFAULT_SLOW_WINDOW_MS,
	slowLogIntervalMs: overrides?.slowLogIntervalMs ?? 1500,
	dropOnOpen: overrides?.dropOnOpen ?? false,
});

// Circuit breakers for database pools (primary and replica have independent breaker state)
const circuitBreakers = {
	primary: createCircuitBreaker('MySQL-Primary', createBreakerOptions()),
	replica: createCircuitBreaker(
		'MySQL-Replica',
		createBreakerOptions({
			failureThreshold: 4,
			timeoutMs: DEFAULT_REPLICA_TIMEOUT_MS,
			cooldownMs: Math.max(10000, Math.floor(DEFAULT_SLOW_COOLDOWN_MS / 2)),
			slowBurst: DEFAULT_SLOW_BURST + 2,
		})
	),
};

// PARAM COUNT (LOG ONLY) -------------------------------------------------------
// Steps: log only the count so diagnosis is possible without leaking parameter values.
const getParamCount = (params: any): number => {
	if (Array.isArray(params)) return params.length;
	if (params && typeof params === 'object') return Object.keys(params).length;
	return params ? 1 : 0;
};

// PARAMS SNIPPET (SAFE FOR LOGS) ----------------------------------------------
// Steps: emit only a small preview for slow-query diagnosis, redact token-like strings, and truncate long values so logs stay safe and bounded.
function summarizeParamsSnippet(params: any): any {
	// STRING SANITIZER ----------------------------------------------------------
	const safeParam = (value: any): any => {
		if (typeof value !== 'string') return value;
		const trimmed: string = value.trim();
		const looksLikeJwt: boolean = trimmed.split('.').length === 3 && trimmed.length > 40;
		if (looksLikeJwt || trimmed.toLowerCase().startsWith('bearer ')) return '[REDACTED]';
		return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
	};

	// ARRAY PARAMS --------------------------------------------------------------
	if (Array.isArray(params)) return params.slice(0, 3).map(safeParam);

	// OBJECT PARAMS -------------------------------------------------------------
	if (params && typeof params === 'object')
		return Object.fromEntries(
			Object.entries(params)
				.slice(0, 6)
				.map(([k, v]) => [k, safeParam(v)])
		);

	// OTHER ---------------------------------------------------------------------
	return params ? safeParam(params) : null;
}

// SQL SUMMARY (LOG ONLY) -------------------------------------------------------
// Steps: normalize whitespace and truncate to a bounded length so slow query logs remain readable and low-risk.
function summarizeSql(sql: any): string | undefined {
	if (!sql) return undefined;
	const text: string = typeof sql === 'string' ? sql : typeof sql === 'object' && typeof sql.sql === 'string' ? sql.sql : String(sql);
	return text.replace(/\s+/g, ' ').trim().slice(0, SQL_LOG_MAX_CHARS);
}

// INSTRUMENT POOL --------------------------------------------------------------
// Steps: wrap execute/query so they run through the circuit breaker, attach log context (safe SQL/param previews), and enforce driver timeout where supported.
const instrumentPool = (pool: any, label: 'primary' | 'replica'): any => {
	const breaker = label === 'primary' ? circuitBreakers.primary : circuitBreakers.replica;

	const wrap = (methodName: 'execute' | 'query'): void => {
		const original = pool[methodName]?.bind(pool);
		if (!original) return;
		pool[methodName] = async (sql: any, params?: any) => {
			const context = {
				pool: label,
				method: methodName,
				paramsCount: getParamCount(params),
				paramsSnippet: summarizeParamsSnippet(params),
				sql: summarizeSql(sql),
			};
			// Driver-level timeout is only supported by mysql2 for `.query({ sql, timeout })`.
			// For `.execute` we rely on the breaker timeout (Node-side), plus optional server-side
			// `max_execution_time` session setting for SELECTs (see DB_SESSION_MAX_EXECUTION_TIME_MS).
			const exec = () => {
				const driverTimeoutMs: number = label === 'replica' ? DEFAULT_REPLICA_TIMEOUT_MS : DEFAULT_QUERY_TIMEOUT_MS;
				if (methodName === 'query' && driverTimeoutMs > 0) {
					const sqlText: string = toSqlString(sql) || sql;
					return original({ sql: sqlText, timeout: driverTimeoutMs }, params);
				}
				return original(sql, params);
			};
			// BREAKER RESULT NORMALIZATION ----------------------------------------
			// breaker.execute is generic; mysql2 returns [rows, fields]. Keep return shape untouched.
			const breakerResult: any = await breaker.execute(exec, context);
			return breakerResult;
		};
	};
	wrap('execute');
	wrap('query');
	return pool;
};

// BUILD POOL -------------------------------------------------------------------
// Steps: create mysql2 pool, convert to promise API, then instrument so all usage goes through breaker/log policy.
const buildPool = (cfg, label) => instrumentPool(mySQL.createPool(cfg).promise(), label);

// Live pool instances (can be rebuilt at runtime by healthcheck logic)
let writePool = buildPool(config, 'primary');
let readPool = buildPool(readConfig, 'replica');

// Replica routing state:
// - replicaSuspendedUntil: temporary circuit to stop using replica after a failure
// - replicaWarmupTimer/Attempts: warmup loop control
let replicaSuspendedUntil = 0;
let replicaWarmupTimer = null;
let replicaWarmupAttempts = 0;

// SESSION INIT (OPTIONAL) ------------------------------------------------------
// Steps: set per-connection session vars (timezone and optional max_execution_time) so time math is consistent and runaway SELECTs are bounded server-side.
const DB_SESSION_MAX_EXECUTION_TIME_MS = Number(process.env.DB_SESSION_MAX_EXECUTION_TIME_MS || 0);
const DB_SESSION_TIME_ZONE = String(process.env.DB_SESSION_TIME_ZONE || '+00:00').trim();
const initSessionOnPool = (pool, label) => {
	const rawPool = pool?.pool; // mysql2 PromisePool exposes underlying pool at `.pool`
	if (!rawPool?.on) return;
	rawPool.on('connection', conn => {
		try {
			// SESSION TIMEZONE (UTC) ------------------------------------------------
			// Ensures NOW(), TIMESTAMPDIFF, and DATETIME comparisons are consistent across nodes.
			if (DB_SESSION_TIME_ZONE) conn.query(`SET SESSION time_zone = '${DB_SESSION_TIME_ZONE.replace(/'/g, "''")}'`);

			// MAX EXECUTION TIME ----------------------------------------------------
			if (DB_SESSION_MAX_EXECUTION_TIME_MS) conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(DB_SESSION_MAX_EXECUTION_TIME_MS))}`);
		} catch (e) {
			sqlLogger.alert('Failed to init session variable', { pool: label, error: e?.message });
		}
	});
};
initSessionOnPool(writePool, 'primary');
initSessionOnPool(readPool, 'replica');

// REPLICA WARMUP SQL (SAFE IDENTIFIER) -----------------------------------------
// Steps: allow warmup table via env without injection by whitelisting identifier chars, supporting schema.table, and backtick-escaping each segment.
const sanitizeIdentifierPart = value => {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return /^[A-Za-z0-9_$-]+$/.test(trimmed) ? trimmed : null;
};
const escapeIdentifierPart = value => `\`${value.replace(/`/g, '``')}\``;
const escapeQualifiedIdentifier = value => {
	const raw = String(value || '').trim();
	if (!raw) return null;
	const parts = raw
		.split('.')
		.map(p => sanitizeIdentifierPart(p))
		.filter(Boolean);
	if (!parts.length || parts.length !== raw.split('.').filter(p => p.trim().length).length) return null;
	return parts.map(escapeIdentifierPart).join('.');
};

// WARMUP SQL RESOLUTION --------------------------------------------------------
// Steps: prefer explicit SQL when provided, otherwise build a safe SELECT 1 query against a sanitized table (defaults to miscellaneous).
const defaultWarmupTable = escapeQualifiedIdentifier(READ_WARMUP_TABLE) || escapeQualifiedIdentifier('miscellaneous');
const warmupSql = READ_WARMUP_SQL || (defaultWarmupTable ? `SELECT 1 FROM ${defaultWarmupTable} LIMIT 1` : null);

// TOGGLE READ SPLIT ------------------------------------------------------------
// Steps: flip routing on warmup success/failure (and future toggles).
const setReadSplitEnabled = nextState => {
	if (readSplitEnabled === nextState) return;
	readSplitEnabled = nextState;
};

// REPLICA WARMUP SCHEDULER -----------------------------------------------------
// Steps: run warmup after delay, retry up to max attempts on failure, and enable read split only after the first success.
const scheduleReplicaWarmup = (delay = READ_WARMUP_RETRY_MS) => {
	if (!READ_SPLIT_REQUESTED || !warmupSql) return;
	if (replicaWarmupTimer) clearTimeout(replicaWarmupTimer);
	replicaWarmupTimer = setTimeout(async () => {
		try {
			replicaWarmupAttempts += 1;
			await readPool.execute(warmupSql);
			setReadSplitEnabled(true);
			reportSubsystemReady('MYSQL_REPLICA');
			replicaWarmupTimer && clearTimeout(replicaWarmupTimer);
			replicaWarmupTimer = null;
		} catch (error) {
			const attemptInfo = `attempt ${replicaWarmupAttempts}/${READ_WARMUP_MAX_ATTEMPTS}`;
			const canRetry = replicaWarmupAttempts < READ_WARMUP_MAX_ATTEMPTS;
			const sqlState = error?.sqlState || 'unknown';
			sqlLogger.alert('Replica warmup check failed', {
				error: error.message,
				code: error?.code,
				sqlState,
				attempt: replicaWarmupAttempts,
				retry: canRetry,
			});
			if (canRetry) {
				scheduleReplicaWarmup(READ_WARMUP_RETRY_MS);
			} else {
				sqlLogger.error(`Replica warmup aborted after ${attemptInfo}. Keeping read splitting disabled.`);
			}
		}
	}, Math.max(READ_WARMUP_DELAY_MS, delay));
};

// When read splitting is requested, start in disabled mode until warmup passes.
if (READ_SPLIT_REQUESTED && warmupSql) {
	setReadSplitEnabled(false);
	scheduleReplicaWarmup(READ_WARMUP_DELAY_MS);
}
// Report MySQL primary as ready after module load (deferred to allow cluster init)
setImmediate(() => reportSubsystemReady('MYSQL_PRIMARY'));

// SQL ROUTING HEURISTICS -------------------------------------------------------
// Steps: route using cheap string checks (not a parser), avoid lock-sensitive reads on replica, and allow per-query overrides via hints/options.
const stripLeadingComments = text => {
	if (!text) return '';
	let trimmed = text.trimStart();
	const blockComment = /^\/\*[\s\S]*?\*\//;
	const lineComment = /^--.*(\r?\n|$)/;
	while (true) {
		if (trimmed.startsWith('/*')) {
			const match = trimmed.match(blockComment);
			if (!match) break;
			trimmed = trimmed.slice(match[0].length).trimStart();
			continue;
		}
		if (trimmed.startsWith('--')) {
			const match = trimmed.match(lineComment);
			if (!match) break;
			trimmed = trimmed.slice(match[0].length).trimStart();
			continue;
		}
		break;
	}
	return trimmed;
};

const toSqlString = sql => {
	if (typeof sql === 'string') return sql;
	if (sql && typeof sql === 'object' && typeof sql.sql === 'string') return sql.sql;
	return '';
};

const containsHint = (sqlText, hint) => sqlText.toLowerCase().includes(hint);

// ROUTING OPTIONS --------------------------------------------------------------
// NOTE: type-only routing options removed (minimal backend typing).

// SHOULD USE REPLICA? ----------------------------------------------------------
// Steps: require read split enabled, honor force hints/options, honor suspension window, require read verb prefix, and reject lock-sensitive statements (FOR UPDATE / LOCK IN SHARE MODE).
const shouldUseReplica = (sql, options: any = {}) => {
	if (!readSplitEnabled) return false;
	const statement = toSqlString(sql);
	if (!statement) return false;
	if (containsHint(statement, FORCE_PRIMARY_HINT)) return false;
	if (containsHint(statement, FORCE_REPLICA_HINT)) return true;
	if (options.forcePrimary) return false;
	if (options.forceReplica) return true;
	if (Date.now() < replicaSuspendedUntil) return false;
	const normalized = stripLeadingComments(statement);
	if (!normalized) return false;
	const upper = normalized.toUpperCase();
	const isReadable = READABLE_PREFIXES.some(prefix => upper.startsWith(prefix));
	if (!isReadable) return false;
	if (upper.includes('FOR UPDATE') || upper.includes('LOCK IN SHARE MODE')) return false;
	return true;
};

// REPLICA EXEC WITH FALLBACK ---------------------------------------------------
// Steps: run on replica, and when fallback is allowed, suspend replica routing briefly on failure then retry on primary.
const runOnReplicaWithFallback = async (methodName: 'execute' | 'query', sql: any, params: any, allowFallback: boolean): Promise<any> => {
	const replicaMethod = readPool[methodName]?.bind(readPool);
	if (!replicaMethod) return writePool[methodName]?.call(writePool, sql, params);
	try {
		return await replicaMethod(sql, params);
	} catch (error: any) {
		if (!allowFallback) throw error;
		replicaSuspendedUntil = Date.now() + READ_FAILBACK_MS;
		sqlLogger.alert('Replica query failed, retrying on primary', {
			error: error.message,
			method: methodName,
		});
		return writePool[methodName]?.call(writePool, sql, params);
	}
};

// NORMALIZE ROUTE OPTIONS ------------------------------------------------------
// Steps: treat non-objects as empty options so callsites can omit/NULL the third argument safely.
const normalizeOptions = (options: any): any => (options && typeof options === 'object' ? options : {});

// ROUTED METHOD FACTORY --------------------------------------------------------
// Steps: build execute/query wrappers that choose replica only when safe, allow explicit forcePrimary/forceReplica, and fall back to primary on replica errors unless replica is forced.
const createRoutedMethod = (methodName: 'execute' | 'query') => {
	return async (sql: any, params?: any, options?: any) => {
		const opts: any = normalizeOptions(options);
		if (opts.forcePrimary) {
			return writePool[methodName]?.call(writePool, sql, params);
		}
		const routeToReplica: boolean = opts.forceReplica || shouldUseReplica(sql, opts);
		if (routeToReplica) {
			return runOnReplicaWithFallback(methodName, sql, params, !opts.forceReplica);
		}
		return writePool[methodName]?.call(writePool, sql, params);
	};
};

const routedExecute = createRoutedMethod('execute');
const routedQuery = createRoutedMethod('query');

// SQL FACADE (PROXY) -----------------------------------------------------------
// Steps: expose routed execute/query by default, expose explicit escape hatches, and forward everything else to primary so existing mysql2 APIs remain available.
const Sql: any = new Proxy(
	{},
	{
		get: (_target, prop) => {
			if (prop === 'execute') return routedExecute;
			if (prop === 'query') return routedQuery;
			if (prop === 'executeOnPrimary') return (sql, params) => writePool.execute(sql, params);
			if (prop === 'executeOnReplica') return (sql, params) => readPool.execute(sql, params);
			if (prop === 'getPrimaryPool') return () => writePool;
			if (prop === 'getReplicaPool') return () => readPool;
			const value = writePool[prop];
			return typeof value === 'function' ? value.bind(writePool) : value;
		},
		set: (_target, prop, value) => {
			writePool[prop] = value;
			return true;
		},
	}
);

/**
 * SqlRead proxy facade:
 * Direct passthrough to the replica pool (no routing, no fallback).
 *
 * Intended uses:
 * - explicitly read-from-replica tasks where eventual consistency is acceptable
 * - diagnostics and warmup checks
 *
 * Anti-pattern:
 * - using SqlRead for anything that must observe a just-written value
 *   (replication lag can break correctness).
 */
const SqlRead: any = new Proxy(
	{},
	{
		get: (_target, prop) => {
			const value = readPool[prop];
			return typeof value === 'function' ? value.bind(readPool) : value;
		},
		set: (_target, prop, value) => {
			readPool[prop] = value;
			return true;
		},
	}
);

// POOL LIFECYCLE / HEALTHCHECKS ------------------------------------------------
// Steps: validate connectivity on a schedule, log rough utilization, and rebuild pools after failures (stale sockets/server restarts) so the rest of the app stays insulated.
const closePoolQuietly = async (pool: any): Promise<void> => {
	try {
		await pool.end();
	} catch (error: any) {
		sqlLogger.alert(`Failed to close pool gracefully: ${error.message}`);
	}
};

// REBUILD PRIMARY POOL ---------------------------------------------------------
// Steps: close old pool, rebuild with instrumentation, re-attach session hooks, then log success so operators can correlate outage recovery.
const rebuildWritePool = async (): Promise<void> => {
	await closePoolQuietly(writePool);
	writePool = buildPool(config, 'primary');
	// Re-attach per-connection session init hooks on the new pool instance
	initSessionOnPool(writePool, 'primary');
	sqlLogger.info('Primary pool reset successfully');
};

// REBUILD REPLICA POOL ---------------------------------------------------------
// Steps: close old pool, rebuild, re-attach session hooks, reset suspension, then re-run warmup gating so reads don't route to an unvalidated replica pool.
const rebuildReadPool = async (): Promise<void> => {
	await closePoolQuietly(readPool);
	readPool = buildPool(readConfig, 'replica');
	// Re-attach per-connection session init hooks on the new pool instance
	initSessionOnPool(readPool, 'replica');
	replicaSuspendedUntil = 0;
	// If read splitting was requested, force warmup gating again for the new pool.
	// This prevents routing reads to a fresh replica pool that hasn't been validated yet.
	if (READ_SPLIT_REQUESTED && warmupSql) {
		replicaWarmupAttempts = 0;
		if (replicaWarmupTimer) {
			clearTimeout(replicaWarmupTimer);
			replicaWarmupTimer = null;
		}
		setReadSplitEnabled(false);
		scheduleReplicaWarmup(READ_WARMUP_DELAY_MS);
	}
	sqlLogger.info('Replica pool reset successfully');
};

// POOL MONITOR ---------------------------------------------------------------
// Steps: grab a connection, derive rough pool stats from underlying mysql2 internals, emit warnings on high usage, then run SELECT 1; on failure, attempt pool rebuild.
const monitorPool = (poolGetter: () => any, label: 'primary' | 'replica', rebuildFn: () => Promise<void>) => async (): Promise<void> => {
	try {
		const pool: any = poolGetter();
		const conn: any = await pool.getConnection();
		const underlying: any = pool.pool?.pool ?? pool.pool ?? null;
		const totalConnections: number = underlying?._allConnections?.length ?? 0;
		const idleConnections: number = underlying?._freeConnections?.length ?? 0;
		const connectionLimit: number = underlying?.config?.connectionLimit ?? config.connectionLimit;
		const activeConnections: number = Math.max(totalConnections - idleConnections, 0);
		const stats = {
			label,
			threadId: conn.threadId,
			connectionLimit,
			totalConnections,
			idleConnections,
			activeConnections,
		};
		conn.release();
		// POOL STATS LOGGING ----------------------------------------------------
		// Avoid constant JSON.stringify/log spam across clustered workers; log only when nearing saturation unless explicitly enabled.
		const usageRatio: number = stats.connectionLimit ? stats.totalConnections / stats.connectionLimit : 0;
		const shouldLogStats: boolean = process.env.DB_POOL_STATS_LOG === '1' || usageRatio >= 0.8;
		if (shouldLogStats) sqlLogger.info(`DB Pool Stats: ${JSON.stringify({ ...stats, usageRatio })}`);
		if (usageRatio > 0.9) sqlLogger.alert(`High connection usage (${label}): ${stats.totalConnections}/${stats.connectionLimit}`);
		await pool.execute('SELECT 1');
	} catch (error: any) {
		Catcher({ origin: `${label}ConnectionHealthCheck`, error, req: null, res: null });
		if (typeof rebuildFn === 'function') {
			try {
				sqlLogger.alert(`${label} pool health check failed, attempting to reset pool`);
				await rebuildFn();
			} catch (resetError: any) {
				Catcher({ origin: `${label}ConnectionPoolReset`, error: resetError, req: null, res: null });
			}
		}
	}
};

// CONNECTION HEALTH CHECK ------------------------------------------------------
// Steps: enable by default in prod (unless LIGHT_MODE), schedule cron runs at interval, and on each run log stats + run SELECT 1 + rebuild pool on failure.
const DB_HEALTHCHECK_ENABLED = process.env.DB_HEALTHCHECK ? process.env.DB_HEALTHCHECK !== '0' : process.env.NODE_ENV === 'production' && !LIGHT_MODE;
const DB_HEALTHCHECK_INTERVAL_MIN = Math.max(1, Number(process.env.DB_HEALTHCHECK_INTERVAL_MIN || (LIGHT_MODE ? 30 : 5)));
// Steps: schedule checks for primary, and for replica only when read split is requested.
const connectionHealthCheck = () => {
	const scheduleExpr = `*/${DB_HEALTHCHECK_INTERVAL_MIN} * * * *`;
	cron.schedule(
		scheduleExpr,
		monitorPool(() => writePool, 'primary', rebuildWritePool)
	);
	if (READ_SPLIT_REQUESTED) {
		cron.schedule(
			scheduleExpr,
			monitorPool(() => readPool, 'replica', rebuildReadPool)
		);
	}
};

if (DB_HEALTHCHECK_ENABLED) {
	connectionHealthCheck();
}

// DATABASE BACKUPS -------------------------------------------------------------
// Steps: keep backups off by default, enable explicitly, and schedule via cron helpers that write encrypted artifacts under BACKUP_BASE_DIR/type.
const ENABLE_DB_BACKUPS = process.env.ENABLE_DB_BACKUPS === '1';
// BACKUP CRON REGISTRATION -----------------------------------------------------
// Installs a cron job for the given cadence/type. No-op unless backups are enabled.
const cronBackupDb = (cronTime, type) => {
	if (!ENABLE_DB_BACKUPS) return null;
	return cron.schedule(cronTime, async () => {
		const currentHour = new Date().getHours();
		if (type === 'daily' && currentHour >= 8 && currentHour <= 22) {
			sqlLogger.info(`Skipping ${type} backup during peak hours`);
			return;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
		await backupDatabase(`backup-${timestamp}.sql.gz`, type);
	});
};

// BACKUP DATABASE --------------------------------------------------------------
// Steps: run mysqldump -> gzip stream to disk, then encrypt with AES-256-GCM (scrypt-derived key), then delete plaintext; retry with delay so transient failures don't silently disable backups.
const backupDatabase = async (filename: string, type: string, retries: number = 3): Promise<string> => {
	try {
		const directoryPath: string = path.resolve(BACKUP_BASE_DIR, type);
		const backupFile: string = path.resolve(directoryPath, filename);

		await fsp.mkdir(directoryPath, { recursive: true });

		// Enforce strong encryption password before any plaintext is created
		const encPassword: string = process.env.SQL_CRYPTER || '';
		if (!encPassword || encPassword.length < 16) {
			throw new Error('weak encryption password');
		}

		const mysqldumpPath: string = process.env.MYSQLDUMP_PATH || 'mysqldump';
		// If MYSQLDUMP_PATH is not provided, `mysqldumpPath` is usually just "mysqldump" on PATH.
		// In that case `fs.access("mysqldump")` is incorrect (it is not a filesystem path).
		// Only validate via fs.access when caller provided a path-like value.
		const looksLikePath: boolean = path.isAbsolute(mysqldumpPath) || mysqldumpPath.includes('/') || mysqldumpPath.includes('\\') || mysqldumpPath.startsWith('.') || mysqldumpPath.endsWith('.exe');
		if (looksLikePath) {
			try {
				await fsp.access(mysqldumpPath, fs.constants.X_OK);
			} catch (error: any) {
				throw new Error(`mysqldump executable not found at ${mysqldumpPath}: ${error.message}`);
			}
		}

		return new Promise<string>((resolve, reject) => {
			const dump = spawn(
				mysqldumpPath,
				[
					'--protocol=tcp',
					'-h',
					process.env.HOST || 'localhost',
					'-P',
					String(process.env.DB_PORT || 3306),
					'-u',
					process.env.DB_USER,
					'--single-transaction',
					'--quick',
					'--compress',
					'--routines',
					'--triggers',
					'--events',
					'--set-gtid-purged=OFF',
					'--max_allowed_packet=128M',
					'--net_buffer_length=16384',
					process.env.DB_NAME as string,
				],
				{ env: { ...process.env, MYSQL_PWD: process.env.DB_PASS || '' } }
			);
			// Cap stderr buffering to avoid OOM if mysqldump becomes noisy.
			const MAX_DUMP_STDERR_CHARS: number = Number(process.env.MYSQLDUMP_STDERR_MAX_CHARS || 65536);
			let stderr: string = '';
			dump.stderr.on('data', data => {
				try {
					stderr += data.toString();
					if (stderr.length > MAX_DUMP_STDERR_CHARS) stderr = stderr.slice(-MAX_DUMP_STDERR_CHARS);
				} catch {}
			});
			dump.on('error', error => reject(new Error(`mysqldump process error: ${error.message}`)));

			const gzip = zlib.createGzip({ level: 9 });
			const outGz = fs.createWriteStream(backupFile);
			let dumpClosedCode: number | null = null;
			let pipelineDone: boolean = false;
			let pipelineErr: Error | null = null;

			const maybeEncrypt = async () => {
				if (pipelineDone && dumpClosedCode === 0 && !pipelineErr) {
					try {
						const password: string = encPassword;
						const salt: Buffer = crypto.randomBytes(16);
						const key = await new Promise<Buffer>((resolve, reject) => {
							crypto.scrypt(password, salt, 32, (err, derivedKey) => {
								if (err) reject(err);
								else resolve(derivedKey);
							});
						});
						const iv: Buffer = crypto.randomBytes(12);
						const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
						const outEnc = fs.createWriteStream(`${backupFile}.enc`);
						outEnc.write(Buffer.from('MSBK'));
						outEnc.write(salt);
						outEnc.write(iv);
						await pipelineAsync(fs.createReadStream(backupFile), cipher, outEnc);
						const authTag: Buffer = cipher.getAuthTag();
						await fsp.appendFile(`${backupFile}.enc`, authTag);
						await fsp.unlink(backupFile);
						sqlLogger.info(`Backup saved at ${backupFile}.enc`);
						resolve(`Backup completed successfully: ${backupFile}.enc`);
					} catch (encryptError: any) {
						try {
							await fsp.unlink(backupFile);
						} catch {}
						reject(new Error(`Encryption error: ${encryptError.message}`));
					}
				} else if (pipelineErr) {
					reject(new Error(`Pipe error: ${pipelineErr.message}`));
				} else if (dumpClosedCode !== null && dumpClosedCode !== 0) {
					const tail: string = stderr && stderr.length ? ` (stderr tail: ${stderr})` : '';
					reject(new Error(`mysqldump exited with code ${dumpClosedCode}${tail}`));
				}
			};

			pipeline(dump.stdout, gzip, outGz, err => {
				pipelineErr = (err as Error) || null;
				pipelineDone = true;
				maybeEncrypt();
			});

			dump.on('close', code => {
				dumpClosedCode = code;
				maybeEncrypt();
			});
		});
	} catch (error: any) {
		Catcher({ origin: 'backupDatabase', error, req: null, res: null });
		if (retries > 0) {
			sqlLogger.info(`Retrying backup in 30 seconds... (${retries} attempts left)`);
			await new Promise(resolve => setTimeout(resolve, 30000));
			return backupDatabase(filename, type, retries - 1);
		}
		throw new Error(`Backup failed after multiple attempts: ${error.message}`);
	}
};

// BACKUP RETENTION -------------------------------------------------------------
// Steps: run daily, delete old files by mtime (no filename parsing), and avoid huge parallelism so large dirs don’t spike FD usage.
const cronBackupsDel = () => {
	if (!ENABLE_DB_BACKUPS) return null;
	return cron.schedule('0 5 * * *', async () => {
		const threeMonthsAgo = new Date(new Date().setMonth(new Date().getMonth() - 3));
		for (const type of ['daily', 'weekly', 'monthly']) {
			const directoryPath = path.resolve(BACKUP_BASE_DIR, type);
			try {
				if (fs.existsSync(directoryPath)) {
					const files = await fsp.readdir(directoryPath);
					// Avoid unbounded parallel stat/unlink: can spike FD usage on large dirs.
					for (const file of files) {
						const filePath = path.resolve(directoryPath, file);
						const stat = await fsp.stat(filePath);
						if (stat.mtime < threeMonthsAgo) await fsp.unlink(filePath);
					}
				}
			} catch (error) {
				Catcher({ origin: 'backup deletion', error, req: null, res: null });
			}
		}
	});
};

// RESTORE SQL ARTIFACT ---------------------------------------------------------
// Steps: decrypt `.enc` (AES-256-GCM) into a gz temp, gunzip into .sql temp, then delete artifacts by default; this does NOT import into MySQL (manual step on purpose).
const restoreSQL = async (filename: string, type: string): Promise<{ sqlPath: string | null }> => {
	try {
		const directoryPath: string = path.resolve(BACKUP_BASE_DIR, type),
			backupFile: string = path.resolve(directoryPath, filename),
			keepArtifacts: boolean = process.env.KEEP_RESTORE_ARTIFACTS === '1';
		const tmpDir: string = path.resolve(BACKUP_BASE_DIR, '_restore_tmp');
		await fsp.mkdir(tmpDir, { recursive: true });
		const tmpGz: string = path.resolve(tmpDir, `${path.basename(filename)}.${Date.now()}.gz`);
		const outSql: string = backupFile.endsWith('.gz') ? path.resolve(tmpDir, path.basename(backupFile).replace(/\.gz$/i, '')) : path.resolve(tmpDir, `${path.basename(backupFile)}.sql`);

		// Decrypt AES-256-GCM file with header MSBK|salt|iv|cipher|tag
		const encPath: string = `${backupFile}.enc`;
		const fd = await fsp.open(encPath, 'r');
		try {
			const header: Buffer = Buffer.alloc(4);
			await fd.read(header, 0, 4, 0);
			if (header.toString() !== 'MSBK') throw new Error('invalid backup header');
			const salt: Buffer = Buffer.alloc(16);
			await fd.read(salt, 0, 16, 4);
			const iv: Buffer = Buffer.alloc(12);
			await fd.read(iv, 0, 12, 20);
			const stat: any = await fd.stat();
			const tag: Buffer = Buffer.alloc(16);
			await fd.read(tag, 0, 16, stat.size - 16);
			const cipherStart: number = 32; // after header+salt+iv
			const cipherLen: number = stat.size - cipherStart - 16;
			const readStream = fs.createReadStream(encPath, { start: cipherStart, end: cipherStart + cipherLen - 1 });
			const password: string = process.env.SQL_CRYPTER || '';
			const key = await new Promise<Buffer>((resolve, reject) => {
				crypto.scrypt(password, salt, 32, (err, derivedKey) => {
					if (err) reject(err);
					else resolve(derivedKey);
				});
			});
			const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
			decipher.setAuthTag(tag);
			await pipelineAsync(readStream, decipher, fs.createWriteStream(tmpGz));
		} finally {
			await fd.close();
		}

		await pipelineAsync(fs.createReadStream(tmpGz), zlib.createGunzip(), fs.createWriteStream(outSql));
		try {
			await fsp.unlink(tmpGz);
		} catch {}
		if (!keepArtifacts) {
			try {
				await fsp.unlink(outSql);
			} catch {}
		}

		sqlLogger.info('Database backup decrypted and decompressed successfully!');
		return keepArtifacts ? { sqlPath: outSql } : { sqlPath: null };
	} catch (error: any) {
		sqlLogger.error(`Failed to restore database backup: ${error.message}`);
		throw error;
	}
};

export { Sql, SqlRead, cronBackupDb, cronBackupsDel, restoreSQL, connectionHealthCheck };
