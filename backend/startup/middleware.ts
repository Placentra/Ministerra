// EXPRESS MIDDLEWARE SETUP ====================================================
// HTTP pipeline configuration: logging → security → static → rate limit →
// parsers → JWT → routers → error handlers. Ordering is critical.
// =============================================================================

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';

import { LIGHT_MODE } from './config';
import { initializeMetrics } from './metrics';
import { getLogger } from '../systems/handlers/loggers.ts';
import { Redis } from '../systems/systems.ts';
import { jwtVerify } from '../modules/jwtokens';
import { defaultMiddleware, setupEditorMiddleware } from '../utilities/sanitize';
import masterRouter from '../router';
import { unless } from 'express-unless';

(jwtVerify as any).unless = unless;

const rateLimiterLogger = getLogger('RateLimiter');
const staticAssetsLogger = getLogger('StaticAssets');

// REDIS-BACKED RATE LIMITER ---------------------------------------------------
// One bucket per (windowSec, keyFn(req)). Fast path in Redis; fails open on
// Redis errors so availability has priority over strict throttling.

// CREATE REDIS RATE LIMITER ----------------------------------------------------
// Returns an Express middleware that:
// - computes a stable per-request key via keyFn(req)
// - increments a bucketed counter in Redis
// - rejects with 429 once `max` is exceeded
// Failure mode is deliberately "fail open" to avoid taking the API down if Redis is degraded.
// Steps: lazy-acquire redis once, compute bucket key (window+identity), incr+expire, enforce max, otherwise pass through; on any redis failure, log and allow.
function createRedisRateLimiter({ windowSec, max, keyFn }) {
	let redisClientPromise = null; //  single shared promise to avoid connect races
	const getRedis = async () => redisClientPromise || (redisClientPromise = Redis.getClient().catch(e => ((redisClientPromise = null), Promise.reject(e)))); //  reset on failure so next request can retry
	return async function redisRateLimit(req, res, next) {
		let key;
		try {
			key = keyFn(req);
			if (!key) return next();
			const redis = await getRedis(),
				now = Date.now(),
				bucketKey = `rl:${Math.floor(now / (windowSec * 1000))}:${key}`; //  bucketed counter per window to keep Redis ops O(1)
			const count = await redis.incr(bucketKey);
			if (count === 1) await redis.expire(bucketKey, windowSec);
			if (count > max) {
				rateLimiterLogger.alert('Request rate limited', { key, count, max, windowSec });
				return res.status(429).json({ error: 'rateLimited' });
			}
			return next();
		} catch (err) {
			rateLimiterLogger.error('Rate limiter failed open', { error: err, windowSec, max, key });
			return next();
		}
	};
}

// PARSE LIMITER PATHS ----------------------------------------------------------
// Converts CSV env var lists into clean Express path arrays.
// Empty/whitespace entries are removed to avoid accidental global middleware mounting.
// Steps: split CSV, trim, drop empties so middleware mounting is explicit and predictable.
function parseLimiterPaths(value) {
	return (value || '')
		.split(',')
		.map(entry => entry.trim())
		.filter(Boolean);
}

// FRONTEND STATIC SERVING (SPA) -----------------------------------------------
// Serves Vite build from ../FrontEnd/dist with cache headers.
// Returns SPA handler for catch-all route or null if no dist exists.
// CONFIGURE FRONTEND STATIC ----------------------------------------------------
// Mounts /assets and dist static files with defensive cache headers and no cookies.
// Returns a catch-all handler that serves index.html for SPA routes (HTML Accept only).
// Steps: locate dist dir, mount immutable /assets, mount dist static with safe cache headers, then return a GET-only html-accepting catch-all that bypasses API prefixes.
function configureFrontendStatic(app, __dirname) {
	try {
		const distCandidates = [path.resolve(__dirname, '../frontend/dist'), path.resolve(__dirname, '../FrontEnd/dist')]; //  support both repo layouts (case-sensitive on Linux)
		const distDir = distCandidates.find(p => fs.existsSync(p));
		if (!distDir) return null;

		const indexFile = path.join(distDir, 'index.html'),
			assetsDir = path.join(distDir, 'assets');
		const normalizedIndexFile = path.normalize(indexFile),
			normalizedAssetsDir = path.normalize(assetsDir);
		const hasIndex = fs.existsSync(indexFile),
			hasAssets = fs.existsSync(assetsDir);
		const assetCacheHeader = 'public, max-age=31536000, immutable',
			htmlCacheHeader = 'no-cache, no-store, must-revalidate',
			otherCacheHeader = 'public, max-age=3600';

		if (hasAssets) {
			app.use(
				'/assets',
				express.static(assetsDir, {
					index: false,
					fallthrough: true,
					setHeaders: res => {
						try {
							res.set('Cache-Control', assetCacheHeader);
							res.set('X-Content-Type-Options', 'nosniff');
							if (typeof res.removeHeader === 'function') res.removeHeader('Set-Cookie');
						} catch (_) {}
					},
				})
			);
		}

		app.use(
			express.static(distDir, {
				index: false,
				setHeaders: (res, servedPath) => {
					try {
						const normalizedServed = path.normalize(servedPath);
						if (hasAssets && normalizedServed.startsWith(normalizedAssetsDir)) res.set('Cache-Control', assetCacheHeader);
						else if (hasIndex && normalizedServed === normalizedIndexFile) res.set('Cache-Control', htmlCacheHeader);
						else res.set('Cache-Control', otherCacheHeader);
						res.set('X-Content-Type-Options', 'nosniff');
						if (typeof res.removeHeader === 'function') res.removeHeader('Set-Cookie');
					} catch (_) {}
				},
			})
		);

		if (!hasIndex) return null;

		const SPA_BYPASS_PREFIXES = ['/admin', '/metrics', '/public', '/assets', '/socket.io'];
		return (req, res, next) => {
			try {
				if (req.method !== 'GET' && req.method !== 'HEAD') return next();
				const accept = req.headers?.accept;
				if (accept && !accept.includes('text/html')) return next();
				const pathname = (req.path || '').toLowerCase();
				if (SPA_BYPASS_PREFIXES.some(prefix => pathname.startsWith(prefix))) return next();
				res.set('Cache-Control', htmlCacheHeader);
				res.set('X-Content-Type-Options', 'nosniff');
				return res.sendFile(indexFile);
			} catch (err) {
				return next(err);
			}
		};
	} catch (err) {
		staticAssetsLogger.error('Failed to configure frontend static assets', { error: err });
		return null;
	}
}

// HEALTH ENDPOINTS SETUP ------------------------------------------------------
// Minimal endpoints for orchestrator/load-balancer health probes.
// Mounted early (before auth/rate-limit) so probes always succeed when app is up.
function setupHealthEndpoints(app) {
	// HEALTH (LIVENESS) -------------------------------------------------------
	// Returns 200 if Express is responding. No dependency checks.
	app.get('/health', (req, res) => res.status(200).json({ status: 'ok', timestamp: Date.now() }));

	// READY (READINESS) -------------------------------------------------------
	// Returns 200 only after critical subsystems are initialized.
	// Orchestrators should wait for this before routing traffic.
	app.get('/ready', async (req, res) => {
		try {
			const redis = await Redis.getClient();
			await redis.ping();
			res.status(200).json({ status: 'ready', timestamp: Date.now() });
		} catch (error) {
			res.status(503).json({ status: 'not_ready', error: error.message, timestamp: Date.now() });
		}
	});

	// LIVE (DEEP LIVENESS) ----------------------------------------------------
	// Checks active connections are healthy. Use for periodic deep health checks.
	app.get('/live', async (req, res) => {
		const checks = { redis: false, timestamp: Date.now() };
		try {
			const redis = await Redis.getClient();
			await redis.ping();
			checks.redis = true;
			res.status(200).json({ status: 'live', checks });
		} catch (error) {
			res.status(503).json({ status: 'degraded', checks, error: error.message });
		}
	});
}

// MAIN MIDDLEWARE SETUP -------------------------------------------------------
// Called by worker init. Configures full Express middleware stack.
// SETUP MIDDLEWARE -------------------------------------------------------------
// The order is intentional:
// - metrics first so everything downstream is observable
// - static files before CORS/auth to keep assets fast and uncomplicated
// - security headers + parsers before JWT so auth has body access where needed
// - routers before SPA catch-all so API paths are never hijacked by index.html
// Steps: install global middleware in deterministic order, then mount routers, then mount SPA fallback (if present), then final 404 handler.
export function setupMiddleware(app, __dirname) {
	// METRICS ---
	// Expose prom-client metrics early so the rest of the chain is observable.
	initializeMetrics(app);

	const TRUST_PROXY = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 0;
	app.set('trust proxy', TRUST_PROXY);

	// Request ID middleware (correlate logs/metrics) --------------------------
	// REQUEST ID --------------------------------------------------------------
	// Ensures every request has a stable ID for log correlation and client reporting.
	app.use((req, res, next) => {
		if (!req.requestId) {
			const incoming = req.get('x-request-id'),
				rid = incoming && typeof incoming === 'string' && incoming.length ? incoming : nanoid(16);
			req.requestId = rid;
			try {
				res.set('X-Request-ID', rid);
			} catch (_) {}
		}
		next();
	});

	// HEALTH ENDPOINTS --------------------------------------------------------
	// Exposed early (before auth/rate-limit) for orchestrator/load-balancer probes.
	// /health - basic liveness (Express is responding)
	// /ready  - subsystem readiness (all critical subsystems initialized)
	// /live   - deep liveness (connections are healthy)
	setupHealthEndpoints(app);

	// Serve static files before CORS (assets aren't blocked by CORS gate) ----
	// STATIC SERVE ------------------------------------------------------------
	// Public file serving is intentionally cookie-less and long-cacheable to reduce bandwidth.
	app.use(
		'/public',
		express.static(path.join(__dirname, 'public'), {
			setHeaders: res => {
				const isProd = process.env.NODE_ENV === 'production';
				try {
					res.removeHeader('Set-Cookie');
				} catch (_) {}
				res.set('Cache-Control', 'public, max-age=31536000');
				res.set('X-Content-Type-Options', 'nosniff');
				res.set('Cross-Origin-Resource-Policy', isProd ? 'same-site' : 'cross-origin');
			},
		}),
		(req, res) => res.status(404).send('File not found')
	);

	const serveFrontendIndex = configureFrontendStatic(app, __dirname);

	// CORS (before API routes for preflight) ----------------------------------
	// Restricts browser access to explicit origins; non-browser clients typically omit Origin header.
	const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://192.168.1.11:5173'];
	const staticOrigins = [process.env.FRONT_END, process.env.BACK_END];
	const envOrigins = process.env.CORS_ORIGINS?.split(',') || [];
	const allowedOriginsSet = new Set([...envOrigins, ...staticOrigins, ...(process.env.NODE_ENV !== 'production' ? devOrigins : [])].map(o => o?.trim()).filter(Boolean));
	app.use(
		cors({
			origin: (origin, callback) => {
				if (!origin) return callback(null, true);
				if (allowedOriginsSet.has(origin)) return callback(null, true);
				return callback(new Error('Not allowed by CORS'));
			},
			exposedHeaders: ['Content-Type', 'Authorization', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Set-Cookie'],
			credentials: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Cookie'],
		})
	);

	// DEBUG: After CORS ---

	// RATE LIMIT (IP) ---------------------------------------------------------
	// Broad protection against abusive request floods; can be scoped to selected endpoints via env.
	const ipRateLimiter = createRedisRateLimiter({
		windowSec: 60,
		max: 300,
		keyFn: req => {
			const ip = TRUST_PROXY ? req.ip : req.socket?.remoteAddress;
			return ip ? `ip:${ip}` : null;
		},
	});
	const ipLimiterPaths = parseLimiterPaths(process.env.IP_RATE_LIMIT_PATHS ?? (LIGHT_MODE ? '/entrance,/foundation,/setup,/invites' : ''));
	if (ipLimiterPaths.length) app.use(ipLimiterPaths, ipRateLimiter);
	else if (!LIGHT_MODE) app.use(ipRateLimiter);

	// DEBUG: After rate limit ---

	// SECURITY + PARSERS + AUTH ----------------------------------------------
	// Helmet + compression + JSON parser are applied before JWT so auth can inspect req.body when needed.
	app.use(
		cookieParser(process.env.COOKIE_SECRET),
		helmet({
			crossOriginResourcePolicy: false,
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'"],
					styleSrc: ["'self'"],
					imgSrc: ["'self'", 'data:', 'http:', 'https:'],
					connectSrc: ["'self'", 'http:', 'https:', 'ws:', 'wss:'],
					fontSrc: ["'self'", 'https:', 'data:'],
					objectSrc: ["'self'"],
					mediaSrc: ["'self'"],
					frameSrc: ["'self'"],
				},
			},
			referrerPolicy: { policy: 'no-referrer' },
			hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
			xDnsPrefetchControl: { allow: false },
			xFrameOptions: { action: 'sameorigin' },
		}),
		compression({ level: 6, threshold: 1024 }),
		express.json({ limit: '1mb' })
	);

	// DEBUG: After body parsing ---

	// JWT verification
	app.use(
		(jwtVerify as any).unless({
			path: ['/favicon.ico', { url: '/public', methods: ['GET'] }],
		})
	);

	// DEBUG: After JWT ---

	// SANITIZER MIDDLEWARE --------------------------------------------------------
	// Use relaxed array limits for /setup and /editor routes to allow image byte arrays.
	// Other routes use the strict default sanitizer.
	app.use((req, res, next) => {
		const isImageUploadRoute = req.path === '/setup' || req.path === '/editor';
		return isImageUploadRoute ? setupEditorMiddleware(req, res, next) : defaultMiddleware(req, res, next);
	});

	// DEBUG: After defaultMiddleware ---

	// RATE LIMIT (USER) -------------------------------------------------------
	// Tight per-user throttling for endpoints that trigger expensive fanout work.
	const userRateLimiter = createRedisRateLimiter({ windowSec: 60, max: 20, keyFn: req => (req?.body?.userID ? `user:${req.body.userID}` : null) });
	const userLimiterPaths = parseLimiterPaths(process.env.USER_RATE_LIMIT_PATHS ?? (LIGHT_MODE ? '/chat,/content,/discussion,/foundation' : ''));
	if (userLimiterPaths.length) app.use(userLimiterPaths, userRateLimiter);
	else if (!LIGHT_MODE) app.use(userRateLimiter);
	app.use('/', masterRouter);

	// ADMIN DIAGNOSTICS --------------------------------------------------------------
	// Minimal state endpoint for operators; token-gated. Avoid adding heavy queries here.
	app.get('/admin/diag', async (req, res) => {
		try {
			const expected = process.env.ADMIN_TOKEN ? `Bearer ${process.env.ADMIN_TOKEN}` : null;
			if (!expected || req.headers['authorization'] !== expected) return res.status(403).json({ error: 'forbidden' });
			const redisState = (() => {
				try {
					return Redis.getConnectionState();
				} catch (err) {
					rateLimiterLogger.error('Redis.getConnectionState failed', { error: err.message });
					return { state: 'unknown', error: err.message };
				}
			})();
			res.json({
				pid: process.pid,
				workerId: process.env.WORKER_ID,
				uptimeSec: Math.round(process.uptime()),
				node: process.version,
				env: {
					AJWT_SECRET: Boolean(process.env.AJWT_SECRET),
					RJWT_SECRET: Boolean(process.env.RJWT_SECRET),
					COOKIE_SECRET: Boolean(process.env.COOKIE_SECRET),
					MONITORING_TOKEN: Boolean(process.env.MONITORING_TOKEN),
					SQL_CRYPTER: Boolean(process.env.SQL_CRYPTER),
				},
				redis: redisState,
			});
		} catch (e) {
			res.status(500).json({ error: 'diagFailed' });
		}
	});

	// FALLBACK ROUTING --------------------------------------------------------
	// SPA handler only applies when frontend build exists; otherwise return JSON 404.
	if (serveFrontendIndex) app.get('*', serveFrontendIndex);
	app.use((req, res) => res.status(404).json({ reason: 'Not Found' })); // Simplified: all unmatched requests get 404 ---------------------------
}
