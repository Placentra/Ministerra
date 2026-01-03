// PROMETHEUS METRICS ==========================================================
// Guarded metric creators to avoid double registration across HMR/dev reloads.
// Cluster metrics exported for primary, initializeMetrics for workers.
// =============================================================================

import client from 'prom-client';
import { LIGHT_MODE } from './config';
import { getLogger } from '../systems/handlers/logging/index';

const metricsLogger = getLogger('Metrics');
const httpMetricsLogger = getLogger('HTTP');

// METRIC CREATORS (GUARDED) ---------------------------------------------------
// GET OR CREATE GAUGE ----------------------------------------------------------
// Prom-client throws on duplicate metric registration; this helper makes metric
// creation idempotent across dev reloads and clustered imports.
// Steps: return existing metric if present; otherwise attempt create; if creation races, re-fetch and return the winner.
export function getOrCreateGauge(name, help, labelNames = []) {
	const existing = client.register.getSingleMetric(name) as client.Gauge<string> | undefined;
	if (existing) return existing;
	try {
		return new client.Gauge({ name, help, labelNames });
	} catch (e) {
		const retry = client.register.getSingleMetric(name) as client.Gauge<string> | undefined;
		if (retry) return retry;
		throw e;
	}
}

// GET OR CREATE HISTOGRAM ------------------------------------------------------
// Histogram is used for request latency/size distributions. Buckets are caller-defined
// so callers can tune based on expected magnitude (seconds vs ms, etc).
// Steps: same pattern as gauge, but for histogram with explicit buckets.
export function getOrCreateHistogram(name, help, labelNames = [], buckets) {
	const existing = client.register.getSingleMetric(name) as client.Histogram<string> | undefined;
	if (existing) return existing;
	try {
		return new client.Histogram({ name, help, labelNames, buckets });
	} catch (e) {
		const retry = client.register.getSingleMetric(name) as client.Histogram<string> | undefined;
		if (retry) return retry;
		throw e;
	}
}

// GET OR CREATE COUNTER --------------------------------------------------------
// Counter is used for monotonically increasing counts (requests, errors, etc).
// Steps: same pattern as gauge, but for counter; counters must be monotonic.
export function getOrCreateCounter(name, help, labelNames = []) {
	const existing = client.register.getSingleMetric(name) as client.Counter<string> | undefined;
	if (existing) return existing;
	try {
		return new client.Counter({ name, help, labelNames });
	} catch (e) {
		const retry = client.register.getSingleMetric(name) as client.Counter<string> | undefined;
		if (retry) return retry;
		throw e;
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

// HELPERS FOR ROUTE NORMALIZATION ---------------------------------------------
const STATIC_EXT_REGEX = /\.(?:png|jpe?g|webp|gif|svg|ico|css|js|map|woff2?|ttf|otf|txt|mp3|mp4|webm|ogg)$/i;
// STATIC REQUEST DETECTION -----------------------------------------------------
// Filters out asset traffic so metrics represent API load instead of static CDN-like load.
// Steps: treat known prefixes and file extensions as static; exclude them from request timing to keep metrics meaningful.
function isStaticAssetRequest(req) {
	try {
		const p = req.path || req.originalUrl || '';
		if (!p) return false;
		if (p === '/favicon.ico' || p === '/metrics') return true;
		if (p.startsWith('/public/') || p.startsWith('/static/') || p.startsWith('/assets/') || p.startsWith('/events/')) return true;
		return STATIC_EXT_REGEX.test(p);
	} catch {
		return false;
	}
}

// ROUTE LABEL NORMALIZATION ----------------------------------------------------
// Prometheus label cardinality must be controlled; this collapses dynamic paths into
// stable buckets so dashboards remain queryable and storage doesn't explode.
// Steps: prefer express route path when available, else map common static prefixes to wildcards, else fall back to 'unmatched'.
function normalizeRouteLabel(req) {
	try {
		if (req.route?.path) return req.route.path;
		const p = req.path || req.originalUrl || '/';
		if (p.startsWith('/public/')) return '/public/*';
		if (p.startsWith('/events/')) return '/events/*';
		if (p.startsWith('/static/')) return '/static/*';
		if (p.startsWith('/assets/')) return '/assets/*';
		if (STATIC_EXT_REGEX.test(p)) return '/static/*';
		return 'unmatched';
	} catch {
		return 'unmatched';
	}
}

// SANITIZE REQUEST BODY FOR LOGGING -------------------------------------------
// BODY SANITIZATION ------------------------------------------------------------
// Only used for slow-request alerts; redacts obvious secrets and truncates long strings.
// Steps: deep-clone via JSON, redact known secret-like keys, truncate long strings, return undefined on failure.
function sanitizeBodyForLog(body) {
	try {
		if (!body || typeof body !== 'object') return undefined;
		const cloned = JSON.parse(JSON.stringify(body));
		const redactKeys = ['password', 'pass', 'token', 'authorization', 'auth', 'cookie', 'cookies'];
		for (const key of Object.keys(cloned)) {
			if (redactKeys.includes(key.toLowerCase())) cloned[key] = '[REDACTED]';
			else if (typeof cloned[key] === 'string' && cloned[key].length > 256) cloned[key] = cloned[key].slice(0, 256) + '…';
		}
		return cloned;
	} catch {
		return undefined;
	}
}

// WORKER METRICS INITIALIZATION -----------------------------------------------
// HTTP RED metrics (request rate, errors, duration) per worker.
// Aggregated via Prometheus using sum() across workers.
// INITIALIZE METRICS -----------------------------------------------------------
// Wires per-worker metrics collection:
// - default nodejs metrics (CPU/mem/GC)
// - event loop lag gauge
// - HTTP RED metrics with sampling and static-asset filtering
// - token-gated /metrics endpoint in prod
// Steps: register default metrics, start event loop lag sampling, add request/finish hooks for histogram+counter, add error counter, expose /metrics.
export function initializeMetrics(app) {
	try {
		const metricsSampleRate = Math.max(0, Math.min(1, Number(process.env.HTTP_METRIC_SAMPLE_RATE ?? (LIGHT_MODE ? 0.3 : 1))));
		const eventLoopLagIntervalMs = Number(process.env.EVENT_LOOP_LAG_INTERVAL_MS || (LIGHT_MODE ? 2000 : 500));
		const slowRequestThresholdMs = Number(process.env.SLOW_HTTP_MS || (LIGHT_MODE ? 1000 : 400));
		const trackSlowRequests = slowRequestThresholdMs > 0;

		// Default metrics per worker (include GC buckets) ---------------------
		client.collectDefaultMetrics({ labels: { worker_id: process.env.WORKER_ID, pid: String(process.pid) }, gcDurationBuckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5] });

		// Event loop lag metric -----------------------------------------------
		const eventLoopLag = getOrCreateGauge('nodejs_event_loop_lag_seconds', 'Event loop lag in seconds');
		setInterval(() => {
			const start = process.hrtime.bigint();
			setImmediate(() => {
				eventLoopLag.set(Number(process.hrtime.bigint() - start) / 1e9);
			});
		}, eventLoopLagIntervalMs).unref();

		// HTTP RED metrics ----------------------------------------------------
		const httpRequestDuration = getOrCreateHistogram(
			'http_request_duration_seconds',
			'Duration of HTTP requests in seconds',
			['method', 'route', 'status_code'],
			[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
		);
		const httpRequestsTotal = getOrCreateCounter('http_requests_total', 'Total number of HTTP requests', ['method', 'route', 'status_code']);
		const httpErrorsTotal = getOrCreateCounter('http_errors_total', 'Total number of HTTP errors', ['route', 'error_type']);
		const slowHttpRequestsTotal = getOrCreateCounter('slow_http_requests_total', 'Count of HTTP requests exceeding threshold', ['method', 'route', 'status_code', 'threshold_ms']);

		// Request timing middleware -------------------------------------------
		app.use((req, res, next) => {
			if (req.method === 'OPTIONS' || isStaticAssetRequest(req)) return next();
			const shouldSample = metricsSampleRate >= 1 || Math.random() <= metricsSampleRate;
			const shouldTime = shouldSample || trackSlowRequests;
			if (!shouldTime) return next();
			const startHr = process.hrtime.bigint();

			res.on('finish', () => {
				const durationNs = Number(process.hrtime.bigint() - startHr),
					durationSec = durationNs / 1e9,
					durationMs = Math.round(durationSec * 1000);
				const finalRoute = normalizeRouteLabel(req);
				if (shouldSample) {
					httpRequestDuration.observe({ method: req.method, route: finalRoute, status_code: String(res.statusCode) }, durationSec);
					httpRequestsTotal.inc({ method: req.method, route: finalRoute, status_code: String(res.statusCode) });
				}
				if (trackSlowRequests && durationMs >= slowRequestThresholdMs) {
					slowHttpRequestsTotal.inc({ method: req.method, route: finalRoute, status_code: String(res.statusCode), threshold_ms: String(slowRequestThresholdMs) });
					httpMetricsLogger.alert('Slow request', {
						method: req.method,
						route: finalRoute,
						status: res.statusCode,
						duration: durationMs,
						userId: req.body?.userID,
						body: sanitizeBodyForLog(req.body),
					});
				}
			});
			next();
		});

		// Error counter hookup ------------------------------------------------
		app.use((err, req, res, next) => {
			const routePath = normalizeRouteLabel(req);
			httpErrorsTotal.inc({ route: routePath, error_type: err?.name || 'Error' });
			next(err);
		});

		// Per-worker /metrics endpoint ----------------------------------------
		app.get('/metrics', async (req, res) => {
			const token = process.env.MONITORING_TOKEN;
			if (token || process.env.NODE_ENV === 'production') {
				const auth = req.headers['authorization'] || '',
					expected = `Bearer ${token}`;
				if (!token || auth !== expected) return res.status(403).json({ error: 'forbidden' });
			}
			try {
				res.set('Content-Type', client.register.contentType);
				res.end(await client.register.metrics());
			} catch (e) {
				res.status(500).end(String(e));
			}
		});

		// NOTE: Removed per-worker log - 20 workers = 20 identical logs
	} catch (e) {
		metricsLogger.error('Failed to initialize metrics', { error: e });
	}
}
