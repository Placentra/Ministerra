// STARTUP CONFIG ===============================================================
// Centralized runtime configuration for cluster, worker scaling, and env flags.
// Exported constants drive primary process decisions and worker behavior.
// =============================================================================

import os from 'os';

// OVERLOAD THRESHOLDS ----------------------------------------------------------
// Single source of truth for overload detection used by both:
// - primary: scaling decisions and cluster-wide overload broadcast
// - worker threads: local overload flagging in status reports
export const OVERLOAD_THRESHOLDS = {
	TASK_BACKLOG_THRESHOLD: 2,
	TASK_PROCESSING_TIME_THRESHOLD_MS: 8000,
};

// RUNTIME CONFIG OBJECT -------------------------------------------------------
// Governs worker/helper scaling, monitoring cadence and overload thresholds.
// Primary uses these to decide when to spawn/trim helper threads in workers.
export const CONFIG = {
	MAX_WORKERS: os.cpus().length, // Worker configuration -------------------
	TASK_WORKER_ID: '1', // dedicated task worker ID (matches cluster worker ID)
	MIN_HELPERS: 1, // Helper configuration -----------------------------------
	MAX_HELPERS: Math.max(2, Math.floor(os.cpus().length * 0.4)),
	MONITORING_INTERVAL: 20000, // Timing: how often to check worker status --
	SCALING_COOLDOWN: 45000, // minimum time between scaling actions
	TASK_BACKLOG_THRESHOLD: OVERLOAD_THRESHOLDS.TASK_BACKLOG_THRESHOLD, // Overload thresholds (conservative) ---------
	PROCESSING_TIME_THRESHOLD: OVERLOAD_THRESHOLDS.TASK_PROCESSING_TIME_THRESHOLD_MS, // max processing time (ms)
	SUSTAINED_OVERLOAD_DURATION: 30000, // how long overload must persist before scaling
	STABLE_PERIOD_BEFORE_SCALE_DOWN: 60000, // how long to wait before scaling down
};

// WORKER THREAD CONFIG ---------------------------------------------------------
// Worker-thread local timings/retries; shares overload thresholds to avoid drift.
export const WORKER_THREAD_CONFIG = {
	MAX_RETRIES: 3,
	BASE_RETRY_DELAY: 1000,
	DEFAULT_TASK_TIMEOUT: 30000,
	MONITORING_INTERVAL: 20000,
	STATUS_REPORT_INTERVAL: 20000,
	BACKLOG_THRESHOLD: OVERLOAD_THRESHOLDS.TASK_BACKLOG_THRESHOLD,
	PROCESSING_TIME_THRESHOLD: OVERLOAD_THRESHOLDS.TASK_PROCESSING_TIME_THRESHOLD_MS,
	HELPER_CHECK_INTERVAL: 8000,
	MAX_TASK_HISTORY: 5,
	MAX_CONCURRENT_TASKS: 3,
	HEARTBEAT_INTERVAL: 5000,
};

// ENV FLAGS -------------------------------------------------------------------
export const LIGHT_MODE = process.env.LIGHT_MODE === '1';
export const ENABLE_CBOR = process.env.ENABLE_CBOR ? process.env.ENABLE_CBOR !== '0' : true;
export const MIN_MODE = process.env.MIN_MODE === '1' || String(process.env.MIN_MODE).toLowerCase() === 'true';
export const DEBUG_LOG_ENABLED = process.env.DEBUG_LOG === '1' || process.env.NODE_ENV !== 'production';

// ENV VALIDATION --------------------------------------------------------------
// Enforces presence and minimum length of signing secrets.
// In dev, we tolerate missing/weak values to ease local iterations.
// VALIDATE ENV ----------------------------------------------------------------
// Throws only in production because missing secrets make auth/session integrity unsafe.
// This function is called in app bootstrap before cluster/workers are started.
export function validateEnv() {
	const required = ['AJWT_SECRET', 'RJWT_SECRET', 'COOKIE_SECRET', 'AUTH_CRYPTER'];
	const missing = required.filter(k => !process.env[k] || String(process.env[k]).length < 16);
	if (missing.length && process.env.NODE_ENV === 'production') throw new Error(`Missing or weak required environment variables: ${missing.join(', ')}`);
}
