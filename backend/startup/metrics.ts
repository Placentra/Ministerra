// PROMETHEUS METRICS ==========================================================
// Guarded metric creators to avoid double registration across HMR/dev reloads.
// Cluster metrics exported for primary, initializeMetrics for workers.
// =============================================================================

import client, { Gauge, Histogram, Counter } from 'prom-client';
import type { Application, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { LIGHT_MODE } from './config';
import { getLogger } from '../systems/handlers/loggers.ts';

const metricsLogger = getLogger('Metrics');
const httpMetricsLogger = getLogger('HTTP');

// INIT GUARDS -----------------------------------------------------------------
// Prevent duplicated collectors/intervals if initializeMetrics is called more than once
// in the same process (dev reloads / accidental double wiring).
const METRICS_INIT_GUARD_KEY = '__ministerra_metrics_initialized__';
const DEFAULT_METRICS_GUARD_KEY = '__ministerra_default_metrics_started__';

// TYPE DEFINITIONS ------------------------------------------------------------
type MetricName = string;

interface GlobalMetricsState {
	[METRICS_INIT_GUARD_KEY]?: boolean;
	[DEFAULT_METRICS_GUARD_KEY]?: boolean;
}

// STATIC ASSET DETECTION REGEX ------------------------------------------------
// Compiled once at module load for zero per-request allocation.
const STATIC_EXT_REGEX = /\.(?:png|jpe?g|webp|gif|svg|ico|css|js|map|woff2?|ttf|otf|txt|mp3|mp4|webm|ogg)$/i;

// STATIC PREFIX TABLE ---------------------------------------------------------
// O(1) prefix lookup instead of multiple startsWith calls.
const STATIC_PREFIXES = new Set(['/public/', '/static/', '/assets/', '/events/']);

// SENSITIVE KEY PATTERNS ------------------------------------------------------
// Lowercase patterns for O(1) Set lookup instead of O(n) array scan.
const SENSITIVE_KEYS = new Set([
	'password',
	'pass',
	'token',
	'authorization',
	'auth',
	'cookie',
	'cookies',
	'secret',
	'apikey',
	'api_key',
	'accesstoken',
	'access_token',
	'refreshtoken',
	'refresh_token',
	'credential',
	'credentials',
	'private',
	'privatekey',
	'private_key',
	'ssn',
	'creditcard',
	'credit_card',
	'cvv',
	'pin',
]);

// METRIC CREATORS (GUARDED) ---------------------------------------------------
// GET OR CREATE GAUGE ---------------------------------------------------------
// Prom-client throws on duplicate metric registration; this helper makes metric
// creation idempotent across dev reloads and clustered imports.
export function getOrCreateGauge<Labels extends string = string>(name: MetricName, help: string, labelNames: Labels[] = []): Gauge<Labels> {
	const existing = client.register.getSingleMetric(name) as Gauge<Labels> | undefined;
	if (existing) return existing;
	try {
		return new client.Gauge<Labels>({ name, help, labelNames });
	} catch (creationError) {
		// Race condition fallback: another caller registered between check and create
		const retry = client.register.getSingleMetric(name) as Gauge<Labels> | undefined;
		if (retry) return retry;
		throw Object.assign(new Error(`Failed to create gauge metric: ${name}`), { cause: creationError });
	}
}

// GET OR CREATE HISTOGRAM -----------------------------------------------------
// Histogram is used for request latency/size distributions.
// Buckets are caller-defined for tuning based on expected magnitude.
export function getOrCreateHistogram<Labels extends string = string>(name: MetricName, help: string, labelNames: Labels[] = [], buckets: number[]): Histogram<Labels> {
	const existing = client.register.getSingleMetric(name) as Histogram<Labels> | undefined;
	if (existing) return existing;
	try {
		return new client.Histogram<Labels>({ name, help, labelNames, buckets });
	} catch (creationError) {
		const retry = client.register.getSingleMetric(name) as Histogram<Labels> | undefined;
		if (retry) return retry;
		throw Object.assign(new Error(`Failed to create histogram metric: ${name}`), { cause: creationError });
	}
}

// GET OR CREATE COUNTER -------------------------------------------------------
// Counter is used for monotonically increasing counts (requests, errors, etc).
export function getOrCreateCounter<Labels extends string = string>(name: MetricName, help: string, labelNames: Labels[] = []): Counter<Labels> {
	const existing = client.register.getSingleMetric(name) as Counter<Labels> | undefined;
	if (existing) return existing;
	try {
		return new client.Counter<Labels>({ name, help, labelNames });
	} catch (creationError) {
		const retry = client.register.getSingleMetric(name) as Counter<Labels> | undefined;
		if (retry) return retry;
		throw Object.assign(new Error(`Failed to create counter metric: ${name}`), { cause: creationError });
	}
}

// CLUSTER METRICS (PRIMARY PROCESS) -------------------------------------------
export const clusterWorkersTotalGauge = getOrCreateGauge('cluster_workers_total', 'Total number of cluster workers');
export const clusterWorkersReadyGauge = getOrCreateGauge('cluster_workers_ready', 'Number of ready cluster workers');
export const clusterHelpersTotalGauge = getOrCreateGauge('cluster_helpers_total', 'Total helper threads across workers');
export const clusterTaskOverloadedGauge = getOrCreateGauge('cluster_task_overloaded', 'Task worker overloaded (1=yes,0=no)');
export const clusterWorkerBacklogGauge = getOrCreateGauge('cluster_worker_backlog', 'Task backlog per worker', ['worker_id']);
export const clusterWorkerProcessingMsGauge = getOrCreateGauge('cluster_worker_processing_ms', 'Task processing time per worker (ms)', ['worker_id']);
export const clusterWorkerCpuUsagePercentGauge = getOrCreateGauge('cluster_worker_cpu_usage_percent', 'CPU usage percent per worker', ['worker_id']);

// TASK EXECUTION METRICS ------------------------------------------------------
export const taskExecutionDurationHistogram = getOrCreateHistogram<'task_name' | 'status'>(
	'task_execution_duration_seconds',
	'Duration of background task executions in seconds',
	['task_name', 'status'],
	[0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
);
export const taskExecutionsTotal = getOrCreateCounter<'task_name' | 'status'>('task_executions_total', 'Total background task executions', ['task_name', 'status']);

// STREAM METRICS --------------------------------------------------------------
export const streamPendingGauge = getOrCreateGauge<'stream_name'>('stream_pending_count', 'Pending messages in Redis stream consumer group', ['stream_name']);

// STATIC REQUEST DETECTION ----------------------------------------------------
// Filters out asset traffic so metrics represent API load, not static CDN-like load.
function isStaticAssetRequest(requestPath: string): boolean {
	if (!requestPath) return false;
	if (requestPath === '/favicon.ico' || requestPath === '/metrics') return true;
	// Extract 8-char prefix for static directory check
	if (requestPath.length >= 8) {
		const prefix = requestPath.slice(0, 8);
		if (STATIC_PREFIXES.has(prefix)) return true;
	}
	return STATIC_EXT_REGEX.test(requestPath);
}

// ROUTE LABEL NORMALIZATION ---------------------------------------------------
// Prometheus label cardinality must be controlled; this collapses dynamic paths
// into stable buckets so dashboards remain queryable and storage doesn't explode.
function normalizeRouteLabel(req: Request): string {
	// EXPRESS ROUTE LABEL ----------------------------------------------------
	// Prefer express route match when available; include baseUrl so mounted routers
	// keep stable and accurate labels (avoids everything becoming 'unmatched').
	const expressRouteLabel = extractExpressRouteLabel(req);
	if (expressRouteLabel) return expressRouteLabel;
	const requestPath = req.path || req.originalUrl || '/';
	// Map static prefixes to wildcards
	if (requestPath.length >= 8) {
		const prefix = requestPath.slice(0, 8);
		if (STATIC_PREFIXES.has(prefix)) return prefix + '*';
	}
	if (STATIC_EXT_REGEX.test(requestPath)) return '/static/*';
	return 'unmatched';
}

// EXTRACT EXPRESS ROUTE LABEL -------------------------------------------------
// Converts express route shapes (string/regexp/array) into a stable, low-cardinality label.
function extractExpressRouteLabel(req: Request): string | undefined {
	const routePath = req.route?.path;
	if (!routePath) return undefined;
	const baseUrl = req.baseUrl || '';
	if (typeof routePath === 'string') return baseUrl + routePath;
	if (routePath instanceof RegExp) return baseUrl + '[regexp]';
	if (Array.isArray(routePath)) return baseUrl + '[multi]';
	return baseUrl + String(routePath);
}

// BODY SANITIZATION -----------------------------------------------------------
// Deep redacts secrets for slow-request logging. Handles nested objects and circular refs.
const MAX_STRING_LENGTH = 256;
const MAX_SANITIZE_DEPTH = 4;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 50;
const REDACTED = '[REDACTED]';
const CIRCULAR_REF = '[CIRCULAR]';

// SANITIZE UNKNOWN VALUE ------------------------------------------------------
// Recursively sanitizes values, tracking visited objects to detect cycles.
function sanitizeUnknownValue(value: unknown, depth: number, visitedObjects: WeakSet<object>): unknown {
	// Depth guard
	if (depth > MAX_SANITIZE_DEPTH) return '[MAX_DEPTH]';
	// Primitives pass through (with string truncation)
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) + '…' : value;
	if (typeof value !== 'object') return value;
	// Circular reference detection
	if (visitedObjects.has(value)) return CIRCULAR_REF;
	visitedObjects.add(value);
	// Array handling
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_LENGTH) return `[Array(${value.length})]`;
		return value.map(item => sanitizeUnknownValue(item, depth + 1, visitedObjects));
	}
	// Object handling with key redaction
	const inputObject = value as Record<string, unknown>;
	const keys = Object.keys(inputObject);
	if (keys.length > MAX_OBJECT_KEYS) return `[Object(${keys.length} keys)]`;
	const sanitized: Record<string, unknown> = {};
	for (const key of keys) {
		const lowerKey = key.toLowerCase();
		sanitized[key] = SENSITIVE_KEYS.has(lowerKey) ? REDACTED : sanitizeUnknownValue(inputObject[key], depth + 1, visitedObjects);
	}
	return sanitized;
}

// SANITIZE BODY FOR LOGGING ---------------------------------------------------
function sanitizeBodyForLog(body: unknown): unknown {
	if (!body || typeof body !== 'object') return undefined;
	try {
		return sanitizeUnknownValue(body, 0, new WeakSet<object>());
	} catch {
		return '[SANITIZE_ERROR]';
	}
}

// TIMING-SAFE TOKEN COMPARISON ------------------------------------------------
// Prevents timing attacks on Bearer token validation.
function isTokenValid(providedToken: string, expectedToken: string): boolean {
	if (!providedToken || !expectedToken) return false;
	const providedBuffer = Buffer.from(providedToken, 'utf8');
	const expectedBuffer = Buffer.from(expectedToken, 'utf8');
	if (providedBuffer.length !== expectedBuffer.length) return false;
	return timingSafeEqual(providedBuffer, expectedBuffer);
}

// LOCAL/PRIVATE CALLER DETECTION ----------------------------------------------
// Determines if request originates from localhost or private network (RFC 1918).
// Covers: 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x, ::1, ::ffff: mapped.
function isPrivateNetworkCaller(remoteAddress: string): boolean {
	if (!remoteAddress) return false;
	// IPv6 localhost
	if (remoteAddress === '::1') return true;
	// Handle IPv4-mapped IPv6 addresses
	const ipv4Address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
	// 127.x.x.x - loopback
	if (ipv4Address.startsWith('127.')) return true;
	// 10.x.x.x - Class A private (common in K8s/Docker)
	if (ipv4Address.startsWith('10.')) return true;
	// 192.168.x.x - Class C private
	if (ipv4Address.startsWith('192.168.')) return true;
	// 172.16.0.0/12 - Class B private (Docker bridge)
	if (ipv4Address.startsWith('172.')) {
		const secondOctet = parseInt(ipv4Address.slice(4).split('.')[0], 10);
		return secondOctet >= 16 && secondOctet <= 31;
	}
	return false;
}

// WORKER METRICS INITIALIZATION -----------------------------------------------
// Wires per-worker metrics collection:
// - Default nodejs metrics (CPU/mem/GC)
// - HTTP RED metrics with sampling and static-asset filtering
// - Token-gated /metrics endpoint in prod
export function initializeMetrics(app: Application): void {
	const globalState = globalThis as unknown as GlobalMetricsState;

	// INIT GUARD --------------------------------------------------------------
	// Ensure this wiring only happens once per process to avoid multiple
	// prom-client default collectors and duplicated middleware hooks.
	if (globalState[METRICS_INIT_GUARD_KEY]) return;
	globalState[METRICS_INIT_GUARD_KEY] = true;

	try {
		// CONFIGURATION -------------------------------------------------------
		const rawSampleRate = Number(process.env.HTTP_METRIC_SAMPLE_RATE ?? (LIGHT_MODE ? 0.3 : 1));
		const metricsSampleRate = Math.max(0, Math.min(1, rawSampleRate));
		const slowRequestThresholdMs = Math.max(0, Number(process.env.SLOW_HTTP_MS) || (LIGHT_MODE ? 1000 : 400));
		const shouldTrackSlowRequests = slowRequestThresholdMs > 0;

		// DEFAULT PROCESS METRICS ---------------------------------------------
		// Restored after MySQL idleTimeout fix resolved the actual hang cause.
		if (!globalState[DEFAULT_METRICS_GUARD_KEY]) {
			globalState[DEFAULT_METRICS_GUARD_KEY] = true;
			client.collectDefaultMetrics({ prefix: '' });
		}

		// HTTP RED METRICS ----------------------------------------------------
		const httpRequestDuration = getOrCreateHistogram<'method' | 'route' | 'status_code'>(
			'http_request_duration_seconds',
			'Duration of HTTP requests in seconds',
			['method', 'route', 'status_code'],
			[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
		);
		const httpRequestsTotal = getOrCreateCounter<'method' | 'route' | 'status_code'>('http_requests_total', 'Total number of HTTP requests', ['method', 'route', 'status_code']);
		const httpErrorsTotal = getOrCreateCounter<'route' | 'error_type'>('http_errors_total', 'Total number of HTTP errors', ['route', 'error_type']);
		const slowHttpRequestsTotal = getOrCreateCounter<'method' | 'route' | 'status_code'>('slow_http_requests_total', 'Count of HTTP requests exceeding configured threshold', [
			'method',
			'route',
			'status_code',
		]);
		const httpActiveRequests = getOrCreateGauge('http_active_requests', 'Number of HTTP requests currently being processed');

		// REQUEST TIMING MIDDLEWARE -------------------------------------------
		app.use((req: Request, res: Response, next: NextFunction) => {
			const requestPath = req.path || req.originalUrl || '';
			if (req.method === 'OPTIONS' || isStaticAssetRequest(requestPath)) return next();

			const shouldSample = metricsSampleRate >= 1 || Math.random() < metricsSampleRate;
			const shouldTime = shouldSample || shouldTrackSlowRequests;
			if (!shouldTime) return next();

			httpActiveRequests.inc();
			const startHrtime = process.hrtime.bigint();

			res.on('finish', () => {
				httpActiveRequests.dec();
				const durationNanoseconds = Number(process.hrtime.bigint() - startHrtime);
				const durationSeconds = durationNanoseconds / 1e9;
				const durationMilliseconds = durationNanoseconds / 1e6;
				const routeLabel = normalizeRouteLabel(req);
				const statusCodeLabel = String(res.statusCode);
				const labels = { method: req.method, route: routeLabel, status_code: statusCodeLabel };

				if (shouldSample) {
					httpRequestDuration.observe(labels, durationSeconds);
					httpRequestsTotal.inc(labels);
				}

				if (shouldTrackSlowRequests && durationMilliseconds >= slowRequestThresholdMs) {
					slowHttpRequestsTotal.inc(labels);
					httpMetricsLogger.alert('Slow request', {
						method: req.method,
						route: routeLabel,
						status: res.statusCode,
						durationMs: Math.round(durationMilliseconds),
						thresholdMs: slowRequestThresholdMs,
						userId: (req.body as Record<string, unknown>)?.userID,
						body: sanitizeBodyForLog(req.body),
					});
				}
			});

			next();
		});

		// ERROR COUNTER MIDDLEWARE --------------------------------------------
		app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
			const routeLabel = normalizeRouteLabel(req);
			const errorType = err?.name || err?.constructor?.name || 'Error';
			httpErrorsTotal.inc({ route: routeLabel, error_type: errorType });
			next(err);
		});

		// METRICS ENDPOINT ----------------------------------------------------
		app.get('/metrics', async (req: Request, res: Response) => {
			const monitoringToken = process.env.MONITORING_TOKEN;
			const isProduction = process.env.NODE_ENV === 'production';
			const remoteAddress = String(req.ip || req.socket?.remoteAddress || '');
			const isLocalCaller = isPrivateNetworkCaller(remoteAddress);
			const requireAuthExplicitly = process.env.REQUIRE_METRICS_AUTH === '1';
			const shouldRequireAuth = (isProduction || requireAuthExplicitly) && !!monitoringToken;

			// AUTH CHECK ------------------------------------------------------
			if (!isLocalCaller) {
				if (shouldRequireAuth) {
					const authHeader = String(req.headers['authorization'] || '');
					const expectedAuth = `Bearer ${monitoringToken}`;
					if (!isTokenValid(authHeader, expectedAuth)) return res.status(403).json({ error: 'forbidden' });
				} else if (isProduction) {
					// Production without token configured: deny non-local callers
					return res.status(403).json({ error: 'forbidden' });
				}
			}

			// SERVE METRICS ---------------------------------------------------
			try {
				res.set('Content-Type', client.register.contentType);
				res.end(await client.register.metrics());
			} catch (metricsError) {
				metricsLogger.error('Failed to collect metrics', { error: metricsError });
				res.status(500).end('metrics collection failed');
			}
		});
	} catch (initError) {
		// Reset guard so retry is possible after fixing the issue
		globalState[METRICS_INIT_GUARD_KEY] = false;
		metricsLogger.error('Failed to initialize metrics', { error: initError });
	}
}

// CLEANUP FUNCTION ------------------------------------------------------------
// Allows graceful shutdown of metrics collection (useful for testing/HMR).
export function shutdownMetrics(): void {
	const globalState = globalThis as unknown as GlobalMetricsState;
	globalState[METRICS_INIT_GUARD_KEY] = false;
	globalState[DEFAULT_METRICS_GUARD_KEY] = false;
}
