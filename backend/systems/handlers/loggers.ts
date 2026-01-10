/**
 * Unified Logging System
 * Single-file implementation of structured logging with:
 * - Winston transports (Console, DailyRotateFile)
 * - OpenTelemetry trace correlation
 * - Sensitive data redaction
 * - Thundering herd deduplication
 * - Express middleware
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import fs from 'fs';
import os from 'os';
import path from 'path';
import stringify from 'safe-stable-stringify';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'async_hooks';
import { LRUCache } from 'lru-cache';

// =============================================================================
// CONFIGURATION
// =============================================================================
const LOG_BASE_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.resolve(process.cwd(), 'logging');
const SERVICE_NAME = process.env.SERVICE_NAME || 'ministerra-backend';
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const IS_PROD = ENVIRONMENT === 'production';
const HOSTNAME = os.hostname();

// LOG LEVELS -------------------------------------------------------------------
// Desired channels: debug, info, alert, error (+ slow as a category).
// This removes "http" + "verbose" as first-class levels.
const LEVELS = { error: 0, alert: 1, info: 2, debug: 3 };
const LEVEL_COLORS = { error: 'red bold', alert: 'yellow bold', info: 'cyan bold', debug: 'blue' };
const LOG_LEVEL = process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug');

// LOG DIRECTORIES --------------------------------------------------------------
// Persistence policy: persist ONLY slow + alert + error.
const LOG_DIRS = {
	alert: path.join(LOG_BASE_DIR, 'alert'),
	error: path.join(LOG_BASE_DIR, 'error'),
	slow: path.join(LOG_BASE_DIR, 'slow'),
};

const FEATURES = {
	consoleColors: process.env.LOG_CONSOLE_COLORS !== '0',
	httpToConsole: process.env.LOG_HTTP_STDOUT === '1',
	// Disable expensive callsite capture by default (enable via '1' if needed for debugging)
	captureCallsite: process.env.LOG_INCLUDE_CALLSITE === '1',
};

const SENSITIVE_KEYS = new Set(['email', 'newEmail', 'pass', 'print', 'newPass', 'authorization', 'cookie', 'cookies', 'authtoken']);

// LOG DIR ENSURE ---------------------------------------------------------------
// Create persisted log directories once at startup so transports don't fail.
try {
	Object.values(LOG_DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
} catch {}

export const logContext = new AsyncLocalStorage();
winston.addColors(LEVEL_COLORS);

// GET CLIENT IP ---
// Derives a stable client IP from express request headers/socket.
// Used for auditability and correlating abusive traffic; best-effort only (can be spoofed via x-forwarded-for).
// Steps: prefer x-forwarded-for first hop, otherwise fall back to req.ip or remoteAddress, and strip ::ffff: prefix for IPv4-mapped addresses.
export function getClientIp(req: any): string | undefined {
	if (!req) return undefined;
	const forwarded: string | string[] | undefined = req.headers?.['x-forwarded-for'];
	if (forwarded)
		return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
			.split(',')[0]
			.trim()
			.replace(/^::ffff:/, '');
	return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

// ERROR SERIALIZATION ---
// Converts Error instances (and nested causes) into plain JSON-safe objects.
// Ensures we don't leak sensitive keys into logs while preserving debugging context.
// Steps: pull canonical fields (name/message/stack/code/status), recurse into cause, then copy enumerable fields except sensitive keys.
export function serializeError(err: any): any {
	if (!err || typeof err !== 'object') return { message: String(err) };
	const serialized: any = {
		name: err.name || 'Error',
		message: err.message,
		stack: err.stack,
		code: err.code,
		status: err.status || err.statusCode,
	};
	if (err.cause) serialized.cause = serializeError(err.cause);
	for (const key in err) {
		if (!serialized[key] && !SENSITIVE_KEYS.has(key.toLowerCase())) serialized[key] = err[key];
	}
	return serialized;
}

// SANITIZE ---
// Redacts sensitive keys, truncates large values, and prevents circular references.
// This is the last line of defense before log emission to keep payloads safe + bounded.
// Steps: cap depth, detect circulars, normalize special types (Date/Error/Buffer), then sanitize arrays/objects with size caps and key redaction.
export function sanitize(value: any, depth: number = 0, seen: WeakSet<any> = new WeakSet()): any {
	if (depth > 4) return '[MaxDepth]';
	if (value === null || value === undefined) return value;
	if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
	if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}… [truncated]` : value;
	if (typeof value !== 'object') return value;

	if (seen.has(value)) return '[Circular]';
	seen.add(value);

	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) return serializeError(value);
	if (Buffer.isBuffer(value)) return `[Buffer: ${value.length} bytes]`;

	if (Array.isArray(value)) {
		return value.slice(0, 25).map(i => sanitize(i, depth + 1, seen));
	}

	const output: Record<string, any> = {};
	for (const key of Object.keys(value).slice(0, 50)) {
		if (SENSITIVE_KEYS.has(key.toLowerCase())) output[key] = '[REDACTED]';
		else output[key] = sanitize(value[key], depth + 1, seen);
	}
	return output;
}

// REQUEST DETAILS ---
// Normalizes request fields into a compact object for structured logging.
// `includeBody` is intentionally opt-in to reduce PII risk and payload size.
// Steps: extract method/path/requestId/userId/ip, optionally include sanitized body, return null if req is missing.
export function extractRequestDetails(req: any, { includeBody = false }: { includeBody?: boolean } = {}): any {
	if (!req) return null;
	const details: any = {
		method: req.method,
		path: req.originalUrl || req.url,
		requestId: req.requestId,
		userId: req.userId || req.body?.userID || req.user?.id,
		ip: getClientIp(req),
	};
	if (includeBody && req.body) details.body = sanitize(req.body);
	return details;
}

// DEDUPLICATION CHECK ---
// Prevents "log storms" when the same error repeats rapidly (e.g., downstream outage).
// Emits first few occurrences, then suppresses and finally emits a summary line.
const dedupCache: LRUCache<string, any> = new LRUCache<string, any>({ max: 1000, ttl: 10000 });
function checkDeduplication(level: string, message: string, meta: any, emitCallback: (l: string, m: string, ex: any) => void): boolean {
	if (level !== 'error' && level !== 'alert') return true;

	let sig: string = `${level}:${message}`;
	if (meta?.error?.stack) sig += `:${meta.error.stack.split('\n')[1] || ''}`;
	else if (meta?.module) sig += `:${meta.module}`;

	let entry: any = dedupCache.get(sig);
	if (!entry) {
		dedupCache.set(sig, { count: 1, timer: null, level, message, meta });
		return true;
	}

	entry.count++;
	if (entry.count <= 5) return true;

	if (!entry.timer) {
		entry.timer = setTimeout(() => {
			const e: any = dedupCache.get(sig);
			if (e && e.count > 5) {
				emitCallback(e.level, `... ${e.count - 5} identical logs suppressed ...`, { ...e.meta, dedup_count: e.count - 5 });
			}
			dedupCache.delete(sig);
		}, 10000);
	}
	return false;
}

// CAPTURE CALL SITE ---
// Captures an approximate source location (file:line) for logs that didn't supply one.
// Skips node internals + node_modules + this logger file to avoid noisy/pointless locations.
// Steps: temporarily override stack trace formatter, scan frames until a non-internal location is found, then normalize to a workspace-relative file path.
function captureCallSite(): { file: string; line: number | null } | null {
	if (!FEATURES.captureCallsite) return null;
	const original: any = Error.prepareStackTrace;
	try {
		Error.prepareStackTrace = (_, stack) => stack;
		const stack: any = new Error().stack;
		if (!Array.isArray(stack)) return null;

		for (const frame of stack) {
			const file: string | null = frame.getFileName();
			if (!file || file.startsWith('node:') || file.includes('node_modules') || file.includes('handlers/loggers.ts') || file.includes('logging/index')) continue;

			// Clean path logic
			let clean: string = file.replace(/^file:\/\//, '').replace(/\\/g, '/');
			try {
				const relative: string = path.relative(process.cwd(), clean).replace(/\\/g, '/');
				if (!relative.startsWith('..') && !path.isAbsolute(relative)) clean = relative;
			} catch {}

			return { file: clean.replace(/^.*(?:app|backend)\//, ''), line: frame.getLineNumber() };
		}
	} catch {
	} finally {
		Error.prepareStackTrace = original;
	}
	return null;
}

// BASE FORMAT ---
// Injects host/service/pid, async-local context, and OTel trace/span correlation into every log record.
// Also coerces Error objects into serialized forms so JSON transport never throws.
const baseFormat = winston.format.combine(
	winston.format.timestamp({ format: () => new Date().toISOString() }),
	winston.format(info => {
		info.host = HOSTNAME;
		info.service = SERVICE_NAME;
		info.pid = process.pid;
		const ctx = logContext.getStore();
		if (ctx) Object.assign(info, ctx);

		// Trace correlation
		const span = trace.getSpan(context.active());
		if (span) {
			const sc = span.spanContext();
			info.trace_id = sc.traceId;
			info.span_id = sc.spanId;
		}

		if (info instanceof Error) {
			info.error = serializeError(info);
		}
		if (info.error instanceof Error) info.error = serializeError(info.error);

		return info;
	})()
);

// CONSOLE EXTRA META ---
// Creates a compact "key=value" string for a selected subset of frequently useful fields.
// Keeps console logs readable without dumping the full structured payload.
function formatConsoleExtraMeta(info: any): string {
	const extras: Record<string, any> = {};
	for (const key of ['task', 'mode', 'name', 'sql', 'paramsCount', 'paramsSnippet', 'durationMs', 'rowCount', 'affectedRows', 'insertId', 'changedRows', 'route', 'bodySnippet']) {
		if (info?.[key] !== undefined) extras[key] = info[key];
	}
	const keys: string[] = Object.keys(extras);
	if (!keys.length) return '';
	try {
		// Print as key=value pairs (no JSON braces that look like "extra brackets").
		const parts: string[] = keys.map(key => {
			const value: any = sanitize(extras[key]);
			if (value == null) return `${key}=${String(value)}`;
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return `${key}=${String(value)}`;
			const raw: string = stringify(value) || '';
			const compact: string = raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
			return `${key}=${compact}`;
		});
		return ` ${parts.join(' ')}`;
	} catch {
		return '';
	}
}

// CONSOLE FORMAT ---
// Human-readable line format for console transport. Keeps JSON-only fields out of the hot path.
// Error stacks are printed on a new line to preserve scanability.
const consoleFormat = winston.format.printf(info => {
	// Standardize level label and apply colors
	const label = (info.level === 'debug' ? 'DEBUG' : info.level.toUpperCase()).padEnd(5);
	const colorizedLevel = FEATURES.consoleColors ? winston.format.colorize().colorize(info.level, label) : label;

	// Build the main log line: LEVEL [module] message (prefer module over file:line for cleaner output)
	const location = (info as any).module ? ` [${(info as any).module}]` : '';
	let line = `${colorizedLevel}${location} ${info.message}`;

	// Append trace/context identifiers if present
	const contextParts = [];
	if (info.requestId) contextParts.push(`req=${info.requestId}`);
	if (info.userId) contextParts.push(`user=${info.userId}`);
	if (info.method && info.path) contextParts.push(`${info.method} ${info.path}`);
	if (info.status) contextParts.push(`status=${info.status}`);
	if (info.duration) contextParts.push(`${info.duration}ms`);

	if (contextParts.length) line += ` (${contextParts.join(' ')})`;

	// Add extra metadata (e.g. SQL params, task names)
	line += formatConsoleExtraMeta(info);

	// Multi-line error handling
	const err: any = (info as any).error || (info instanceof Error ? info : null);
	if (err) {
		const stack = err.stack || (typeof err === 'object' ? JSON.stringify(err, null, 2) : String(err));
		line += `\n${stack}`;
	}

	return line;
});

// JSON FORMAT ---
// Stable JSON stringify for file transports; avoids circulars and preserves key ordering.
const jsonFormat = winston.format.printf(info => stringify(info));

// =============================================================================
// LOGGERS
// =============================================================================
// LOGGER FACTORY ---
// Creates a winston logger with daily-rotating file transport (for persisted categories)
// and a console transport (for local visibility). Persistence is controlled by category.
// Steps: decide persistence by category, create transports, then return a logger with custom levels and base format injected.
function createLogger({ category, dir, filePrefix, fileLevel, consoleLevel, loggerLevel }) {
	// PERSISTENCE POLICY -------------------------------------------------------
	// Persist ONLY: alert, error, slow
	const shouldPersist = category === 'alert' || category === 'error' || category === 'slow';
	const transports = [];

	// Console Transport ---
	// Always add Console transport unless in test env.
	if (process.env.NODE_ENV !== 'test') {
		transports.push(
			new winston.transports.Console({
				level: consoleLevel || LOG_LEVEL,
				format: winston.format.combine(baseFormat, consoleFormat),
			})
		);
	}

	if (shouldPersist) {
		transports.push(
			new DailyRotateFile({
				filename: path.join(dir, `${filePrefix}-%DATE%.log`),
				datePattern: 'YYYY-MM-DD',
				zippedArchive: true,
				maxSize: '30m',
				maxFiles: category === 'error' ? '60d' : '30d',
				level: fileLevel,
				format: winston.format.combine(baseFormat, jsonFormat),
			})
		);
	}

	return winston.createLogger({
		levels: LEVELS,
		level: loggerLevel || consoleLevel || fileLevel || LOG_LEVEL,
		transports,
		// Pass category through meta so it's available but not forced into every format
		defaultMeta: { module: 'System' },
		format: winston.format.combine(baseFormat, consoleFormat),
	});
}

// FILE POLICY ------------------------------------------------------------------
// We persist slow + alert + error. Debug/info are console-only.
const debugLogger = createLogger({ category: 'debug', dir: LOG_DIRS.alert, filePrefix: 'debug', fileLevel: 'debug', consoleLevel: LOG_LEVEL, loggerLevel: LOG_LEVEL });
const infoLogger = createLogger({ category: 'info', dir: LOG_DIRS.alert, filePrefix: 'info', fileLevel: 'info', consoleLevel: LOG_LEVEL, loggerLevel: LOG_LEVEL });
const alertLogger = createLogger({ category: 'alert', dir: LOG_DIRS.alert, filePrefix: 'alert', fileLevel: 'alert', consoleLevel: LOG_LEVEL, loggerLevel: LOG_LEVEL });
const errorLogger = createLogger({ category: 'error', dir: LOG_DIRS.error, filePrefix: 'error', fileLevel: 'error', consoleLevel: 'error', loggerLevel: 'error' });
const slowLogger = createLogger({ category: 'slow', dir: LOG_DIRS.slow, filePrefix: 'slow', fileLevel: 'alert', consoleLevel: LOG_LEVEL, loggerLevel: LOG_LEVEL });

// Store categories on loggers for logWith
[debugLogger, infoLogger, alertLogger, errorLogger, slowLogger].forEach((l, i) => ((l as any).cat = ['debug', 'info', 'alert', 'error', 'slow'][i]));

// GLOBAL PROCESS HANDLERS ---
// Persist uncaught exceptions and unhandled rejections to dedicated rotating files.
// Console handler is kept for immediate operator visibility.
const exceptionTransports = [
	new winston.transports.Console({
		format: winston.format.combine(
			baseFormat,
			winston.format(info => {
				info.level = 'error';
				return info;
			})(),
			consoleFormat
		),
	}),
	new DailyRotateFile({
		filename: path.join(LOG_DIRS.error, 'exceptions-%DATE%.log'),
		datePattern: 'YYYY-MM-DD',
		zippedArchive: true,
		maxSize: '30m',
		maxFiles: '60d',
		format: winston.format.combine(baseFormat, jsonFormat),
	}),
];

errorLogger.exceptions.handle(...exceptionTransports);
errorLogger.rejections.handle(...exceptionTransports);

// MAIN LOGGING HANDLER ---------------------------------------------------------
// MAIN LOG EMIT ---
// Central funnel for all log calls: dedup, enrich request metadata, attach callsite, sanitize, then emit.
// This is where we enforce invariants: no raw Errors, no req/res objects, bounded payload size.
// Steps: normalize meta, apply dedup suppression, extract request details, attach callsite if missing, sanitize payload, then emit to the chosen logger.
function logWith(target, level, message, meta) {
	const payload = meta && typeof meta === 'object' ? { ...meta } : meta === undefined ? {} : { value: meta };
	payload.category = (target as any).cat;

	// Deduplication
	const shouldEmit = checkDeduplication(level, message, payload, (l, m, ex) => target.log({ level: l, message: m, ...sanitize(ex) }));
	if (!shouldEmit) return;

	// Context extraction
	if (payload.req || payload.request) {
		payload.request = extractRequestDetails(payload.req || payload.request, { includeBody: level === 'error' });
		delete payload.req;
	}
	delete payload.res;

	// Callsite
	if (!payload.location) {
		const cs = captureCallSite();
		if (cs) payload.location = cs;
	}

	if (payload.error instanceof Error) payload.error = serializeError(payload.error);

	target.log({ level, message, ...sanitize(payload) });
}

// LOGGER FACTORY (PUBLIC API) ---
// Returns a module-scoped logger with consistent meta and convenient helpers.
// `.child()` is the only supported way to extend meta without losing the module name.
// Steps: bind moduleName into meta once, then expose level helpers that route through logWith() with consistent error shaping.
export function getLogger(moduleName, baseMeta = {}) {
	const meta = { module: moduleName, ...baseMeta };
	return {
		debug: (msg, logMeta = {}) => logWith(debugLogger, 'debug', msg, { ...meta, ...logMeta }),
		info: (msg, logMeta = {}) => logWith(infoLogger, 'info', msg, { ...meta, ...logMeta }),
		alert: (msg, logMeta = {}) => logWith(alertLogger, 'alert', msg, { ...meta, ...logMeta }),
		error: (msg, logMeta = {}) => logWith(errorLogger, 'error', msg instanceof Error ? msg.message : msg, { ...meta, ...logMeta, error: msg instanceof Error ? msg : (logMeta as any)?.error }),
		slow: (msg, logMeta = {}) => logWith(slowLogger, 'alert', msg, { ...meta, ...logMeta }),
		child: (childMeta = {}) => getLogger(moduleName, { ...meta, ...childMeta }),
	};
}
