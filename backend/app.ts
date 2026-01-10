// =============================================================================
// BACKEND APP ENTRY POINT
// =============================================================================
// Startup path:
//   1) Validate env, register metrics, then either run in MIN_MODE (single)
//      or as a clustered primary that forks workers.
//   2) Primary coordinates workers (HTTP + SockSet.IO) and a dedicated task
//      worker. It monitors health/overload and scales helper threads.
//   3) Each worker initializes Express middleware in strict order: metrics →
//      access logging → security/CORS → static → rate limit → parsers → JWT →
//      routers → error handler. Ordering is critical.
// Cross-cutting subsystems:
//   • Redis: rate limiting, caches, cluster coordination
//   • Prometheus: app/cluster telemetry (prom-client)
//   • Socket.IO: sticky sessions + cluster adapter
//   • JWT: access/refresh flow in modules/jwtokens.js
// =============================================================================

import dotenv from 'dotenv';
dotenv.config();
import './otel';
import 'express-async-errors';

// DEPENDENCIES ----------------------------------------------------------------
// Cluster + metrics + sticky sessions are initialized in the primary.
// Workers load Express/Socket stacks through cluster/worker.js.
import http from 'http';
import os from 'os';
import cluster from 'cluster';
import client from 'prom-client';
import { setupPrimary } from '@socket.io/cluster-adapter';
import { setupMaster } from '@socket.io/sticky';

import { Redis, Cacher } from './systems/systems.ts';
import { cronBackupDb, cronBackupsDel } from './systems/mysql/mysql.ts';
import { getLogger } from './systems/handlers/loggers.ts';

import { CONFIG, MIN_MODE, validateEnv } from './startup/config.ts';
import { clusterWorkersTotalGauge } from './startup/metrics.ts';
import { primaryState, handleWorkerMessage, handleWorkerExit, checkWorkersAndScale, checkStartupCompletion } from './cluster/primary.ts';
import { initializeWorker, gracefulShutdown } from './cluster/worker.ts';
import { initReadinessTracker } from './cluster/readiness.ts';

// TODO need to implement check if previous backup (any of the 3 types) was done on server start, and if not, do it right away.
// TODO import all modules into one file and export a function, which accepts array of names and returns an object with all the modules
// TODO will need to check if server is starting between 00:00 and 00:05, and if so, run the dailyRecalc task right away before starting the server
// TODO redis has geospatial data types, can be used for radius search
// TODO need to implement regular deletion of previous user profiles images (probably every 2-3 months) (so that images can be still loaded for past event users)
// TODO need to check idempotency across the whole backend = if something fails in the middle, it doesn't leave any persistent traces behind (revert redis and revert mysql)

const clusterLogger = getLogger('Cluster');
const metricsLogger = getLogger('Metrics');

// =============================================================================
// BOOTSTRAP IIFE
// =============================================================================
// Entry point for the entire backend. Branches into three modes:
//   1) MIN_MODE: single-process (task worker only, no clustering)
//   2) cluster.isPrimary: coordinates workers, exposes aggregated metrics
//   3) cluster worker: runs Express + Socket.IO via initializeWorker()
// =============================================================================
(async () => {
	// ENV VALIDATION -----------------------------------------------------------
	// Hard-fail early in production if secrets are missing/weak.
	validateEnv();
	const numCPUs = os.cpus().length;

	// SWARM MODE: CONTAINER ORCHESTRATION -------------------------------------
	// If running in Docker Swarm/K8s, we let the orchestrator handle replicas.
	// We act as a single worker process but with full initialization.
	if (process.env.SWARM_MODE) {
		try {
			clusterLogger.info('Starting (Swarm/Container Mode)');

			// In Swarm, every container is a "worker" but also needs to do its own
			// internal housekeeping if it's the *only* container, OR we rely on
			// external jobs. For simplicity, we initialize as a worker.
			// However, we might need a dedicated "Task Runner" service in the stack
			// or elect one via Redis locking if tasks are duplicated.
			// For now, we assume this container handles traffic.

			// CACHE WARMUP (Non-blocking attempt) -------------------------------
			// In Swarm, multiple containers might start at once.
			// Realistically, we should have an "init container" do this,
			// or use Redis locking to ensure only one does the heavy lift.
			// For now, we'll let them all try (Redis cacher is idempotent-ish).
			try {
				const redis = await Redis.getClient();
				await Cacher(redis);
			} catch (e) {
				clusterLogger.error('Swarm cache warmup failed', { error: e });
			}

			// Identity
			process.env.WORKER_ID = process.env.HOSTNAME || `swarm-${process.pid}`;

			// Run the worker initialization directly
			await initializeWorker();
		} catch (err) {
			clusterLogger.error('Error in Swarm mode', { error: err });
			process.exit(1);
		}
	}
	// MIN_MODE: SINGLE-PROCESS ------------------------------------------------
	else if (MIN_MODE) {
		try {
			clusterLogger.info('Starting (Single-Process Mode)');

			// BACKUPS -----------------------------------------------------------
			// Schedule DB backups even in single-process mode.
			const backups = { daily: '0 1 * * *', weekly: '0 1 * * 1', monthly: '0 1 1 * *' };
			Object.entries(backups).forEach(([type, expr]) => cronBackupDb(expr, type));

			// CACHE WARMUP ------------------------------------------------------
			// Warm caches before serving work; failures must not prevent boot.
			try {
				const redis = await Redis.getClient();
				await Cacher(redis);
				cronBackupsDel();
			} catch (e) {
				clusterLogger.error('Single-process cache warmup failed', { error: e });
			}

			// WORKER ROLE -------------------------------------------------------
			// In MIN_MODE the process runs the task worker path directly.
			process.env.WORKER_ID = CONFIG.TASK_WORKER_ID;
			await initializeWorker();
		} catch (err) {
			clusterLogger.error('Error in single-process mode', { error: err });
			process.exit(1);
		}
	}
	// CLUSTER PRIMARY ---------------------------------------------------------
	else if (cluster.isPrimary) {
		try {
			clusterLogger.info('Starting (Cluster Mode)');

			// Backup cron jobs ------------------------------------------------
			const backups = { daily: '0 1 * * *', weekly: '0 1 * * 1', monthly: '0 1 1 * *' };
			Object.entries(backups).forEach(([type, expr]) => cronBackupDb(expr, type));

			// Redis + cache warmup --------------------------------------------
			const redis = await Redis.getClient();
			await Cacher(redis);
			cronBackupsDel();

			// Sticky Socket.IO server -----------------------------------------
			// Socket.IO sticky listener runs on (BE_PORT + 1) so workers can bind BE_PORT.
			const stickyServer = http.createServer();
			setupMaster(stickyServer, { loadBalancingMethod: 'least-connection' });
			setupPrimary();
			const stickyPort = Number(process.env.SOCKET_PORT || Number(process.env.BE_PORT || 2208) + 1);
			stickyServer.listen(stickyPort, '0.0.0.0', () => {
				clusterLogger.info(`Socket.IO sticky server listening on :${stickyPort}`);
			});

			// TRACK STICKY SERVER FOR SHUTDOWN ---
			// Exporting it or assigning to a global so worker.js shutdown logic can find it.
			// In clustered mode, the primary process needs to close this.
			global.stickyServerRef = stickyServer;

			// WORKER INVENTORY -------------------------------------------------
			// Primary tracks per-worker readiness + helper capacity for scaling decisions.
			primaryState.totalWorkers = numCPUs;
			clusterWorkersTotalGauge.set(numCPUs);

			// Aggregated metrics endpoint -------------------------------------
			// Primary exposes /metrics by aggregating worker registries. Token gates prod.
			try {
				const metricsPort = Number(process.env.MONITORING_PORT || 9464);
				const aggregatorRegistry = new client.AggregatorRegistry();
				http.createServer(async (req, res) => {
					if (req.url === '/metrics') {
						try {
							const token = process.env.MONITORING_TOKEN;
							if (token) {
								const auth = req.headers['authorization'] || '',
									expected = `Bearer ${token}`;
								if (auth !== expected) {
									res.statusCode = 403;
									res.end('forbidden');
									return;
								}
							}
						} catch (err) {
							metricsLogger.error('Metrics auth failed', { error: err.message });
							res.statusCode = 500;
							res.end('Internal Server Error');
							return;
						}
						try {
							const metrics = await (aggregatorRegistry as any).clusterMetrics({ timeout: 15000 });
							res.setHeader('Content-Type', client.register.contentType);
							res.end(metrics);
						} catch (e) {
							try {
								const fallback = await client.register.metrics();
								res.setHeader('Content-Type', client.register.contentType);
								res.end(fallback);
							} catch (inner) {
								res.statusCode = 500;
								res.end(String(e));
							}
						}
						return;
					}
					res.statusCode = 404;
					res.end('Not Found');
				}).listen(metricsPort, '0.0.0.0', () => {
					metricsLogger.info(`Aggregated metrics available at :${metricsPort}/metrics`);
				});
			} catch (e) {
				metricsLogger.error('Failed to start aggregated metrics server', { error: e });
			}

			// Fork workers ----------------------------------------------------
			// WORKER_ID is stable so primary can correlate metrics and helper counts.
			for (let i = 1; i <= numCPUs; i++) {
				const workerId = String(i);
				cluster.fork({ WORKER_ID: workerId, USE_STICKY: '1' });
				primaryState.workerStatus.set(workerId, { isReady: false, lastStatusUpdate: 0, metrics: { backlog: 0, processingTime: 0, cpuUsage: 0 } });
				primaryState.helperCounts.set(workerId, 0);
			}

			// Cluster event handlers ------------------------------------------
			// Control-plane messages drive readiness, health metrics, helper scaling.
			cluster.on('message', (worker, message) => {
				handleWorkerMessage(worker, message);
			});
			cluster.on('exit', (worker, code, signal) => {
				handleWorkerExit(worker, code, signal);
			});

			// Monitoring and scaling ------------------------------------------
			// Periodic scaling is rate-limited in primaryState (cooldown) to avoid thrash.
			setInterval(() => {
				checkWorkersAndScale();
			}, CONFIG.MONITORING_INTERVAL);
			setTimeout(() => {
				checkStartupCompletion();
			}, 10000);
			initReadinessTracker(numCPUs);

			clusterLogger.info(`Forked ${numCPUs} workers (Worker ${CONFIG.TASK_WORKER_ID} handles background tasks)`);
		} catch (err) {
			clusterLogger.error('Error in primary process', { error: err });
			process.exit(1);
		}
	}
	// CLUSTER WORKER ----------------------------------------------------------
	else {
		// WORKER BOOT ---------------------------------------------------------
		// Worker process runs Express + optional Socket.IO, and may host task threads if TASK_WORKER_ID.
		await initializeWorker();
	}
})();

// RE-EXPORT SHUTDOWN FOR SIGNAL HANDLERS --------------------------------------
// Signal handlers are attached in cluster/worker.js
export { gracefulShutdown };
