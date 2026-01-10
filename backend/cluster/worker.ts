// CLUSTER WORKER SETUP ========================================================
// Each worker creates Express app, Socket.IO, and optionally background tasks.
// Handles scaling messages, CBOR enhancement, error handling, and shutdown.
// =============================================================================

import express from 'express';
import http from 'http';
import cluster from 'cluster';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { encode } from 'cbor-x';
import { CONFIG, ENABLE_CBOR, MIN_MODE, DEBUG_LOG_ENABLED } from '../startup/config.ts';
import { setupMiddleware } from '../startup/middleware.ts';
import { Sql, Catcher, Socket, Redis } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { reportSubsystemReady } from './readiness.ts';
import { taskExecutionDurationHistogram, taskExecutionsTotal } from '../startup/metrics.ts';
import { logSection, logStep, logSubsystemReady } from './startupLogger.ts';

const workerLogger = getLogger('Worker');
const shutdownLogger = getLogger('Shutdown');
const expressErrorLogger = getLogger('Express');
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE_SHUTDOWN_MS = Number(process.env.FORCE_SHUTDOWN_MS || (MIN_MODE ? 5000 : 30000));

// WORKER THREAD MAP TYPES ------------------------------------------------------
const WORKER_THREAD_TYPES = { helper: 'helper', task: 'task' };
const TASK_THREAD_NAMES = ['chatTasks', 'contentTasks', 'hourlyRecalc', 'dailyRecalc'];
const taskThreadsInitialized = new Set<string>();

// WORKER THREAD INFO ---
// Shared entry shape for helper and task thread tracking.
function buildWorkerThreadInfo({ workerThread, type, taskName = null, lastPing, terminating = false }) {
	return { worker: workerThread, type, ...(taskName ? { taskName } : {}), lastPing, ...(terminating ? { terminating } : {}) };
}

let httpServerRef,
	socketOnlyServerRef,
	workerThreadsRef,
	shutdownStarted = false;
const sockets = new Set();

// CBOR RESPONSE PATCH ----------------------------------------------------------
// Patches Express `res.json` / `res.send` so clients that advertise CBOR via Accept header
// receive a compact binary payload. This is a transport optimization only (same semantics).
// Steps: wrap json/send once, check Accept header, encode objects to CBOR, otherwise delegate to original methods.
function enhanceResponseWithCbor() {
	const [origJson, origSend] = [express.response.json, express.response.send];

	express.response.json = function (data) {
		if (this.req.get('Accept')?.includes('application/cbor')) return this.type('application/cbor').send(encode(data));
		return origJson.call(this, data);
	};

	express.response.send = function (body) {
		if (body && typeof body === 'object' && !(body instanceof Buffer) && !body.pipe && this.req.get('Accept')?.includes('application/cbor')) return this.type('application/cbor').end(encode(body));
		return origSend.call(this, body);
	};
}

// WORKER THREAD FACTORY --------------------------------------------------------
// Spawns a worker_thread running `systems/worker/worker.ts` under `tsx` and wires IPC:
// - forwards task-worker status to cluster primary
// - tracks liveness via lastPing
// - restarts crashed task threads, but never restarts helpers automatically
// Steps: create worker thread, post initialize message, forward key events, update lastPing, restart only critical task threads, and treat helper exits as capacity reduction.
function createWorkerThread(workerId, taskName, isHelper, workers = null, workerState = null) {
	// ENTRYPOINT PICKING ---
	// Directly resolve the worker entry point to bypass fragile bootloader logic.
	// In dev/TS environment, we use 'worker.ts' with the 'tsx' loader.
	// In prod/JS environment (if compiled), we fall back to 'worker.js'.
	const tsEntry = path.resolve(backendDir, 'systems', 'worker', 'worker.ts');
	const jsEntry = path.resolve(backendDir, 'systems', 'worker', 'worker.js');

	let entrypointPath = jsEntry;
	let execArgv = [];

	// ALTERNATIVE SOLUTION: Use worker-loader.mjs wrapper that registers tsx programmatically
	// This avoids all the --import flag issues in worker_threads
	const loaderWrapper = path.resolve(backendDir, 'systems', 'worker', 'worker-loader.mjs');
	if (fs.existsSync(loaderWrapper)) {
		entrypointPath = loaderWrapper;
		execArgv = [];
	} else if (fs.existsSync(jsEntry)) {
		// Fallback to compiled JS if available
		entrypointPath = jsEntry;
		execArgv = [];
	} else if (fs.existsSync(tsEntry)) {
		// Last resort: try loader approach
		const tsxLoader = path.resolve(backendDir, 'node_modules', 'tsx', 'dist', 'loader.mjs');
		const loaderPath = fs.existsSync(tsxLoader) ? pathToFileURL(tsxLoader).href : 'tsx/esm';
		entrypointPath = tsEntry;
		execArgv = ['--import', loaderPath, '--experimental-specifier-resolution=node'];
	}

	const worker = new Worker(entrypointPath, { execArgv, workerData: { workerId, taskName, isHelper }, stdout: true, stderr: true });

	// WORKER THREAD STDIO --------------------------------------------------------
	// Pipe raw worker output through without reformatting; keep logs owned by the worker.
	worker.stdout?.on('data', data => process.stdout.write(data));
	worker.stderr?.on('data', data => process.stderr.write(data));

	worker.postMessage({ type: 'initialize', workerId, taskName, isHelper });

	worker.on('message', msg => {
		// Ensure workers map exists and has the entry before trying to update it
		if (workers && workers.has(workerId)) {
			workers.set(workerId, { ...workers.get(workerId), lastPing: Date.now() });
		}

		switch (msg.type) {
			case 'heartbeat':
				break;
			case 'worker_status':
				!isHelper && process.send?.({ type: 'worker_status', workerId: process.env.WORKER_ID, ...msg });
				break;
			case 'initialized':
				// Track task thread initialization; report when all 4 are ready
				if (!isHelper && taskName && TASK_THREAD_NAMES.includes(taskName)) {
					taskThreadsInitialized.add(taskName);
					if (taskThreadsInitialized.size === TASK_THREAD_NAMES.length) {
						reportSubsystemReady('TASK_THREADS');
						logSubsystemReady('Task Threads', `${TASK_THREAD_NAMES.length} threads active`);
					}
				}
				break;
			case 'task_metric':
				// TASK METRICS IPC -----------------------------------------------------
				// Worker threads send execution metrics; we update prom-client here.
				if (msg.taskName && typeof msg.durationSeconds === 'number') {
					const status = msg.success ? 'success' : 'failure';
					taskExecutionDurationHistogram.observe({ task_name: msg.taskName, status }, msg.durationSeconds);
					taskExecutionsTotal.inc({ task_name: msg.taskName, status });
				}
				break;
			case 'error':
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Thread ${workerId} error: ${msg.error}`);
				break;
			case 'shutdown':
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Thread ${workerId} shutdown: ${msg.success ? 'ok' : 'failed'}`);
				break;
			default:
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Thread ${workerId} sent message: ${msg.type}`);
		}
	});

	worker.on('error', e => DEBUG_LOG_ENABLED && workerLogger.info(`[Worker Thread:${workerId}] Error: ${e.message}`));

	worker.on('exit', code => {
		if (shutdownStarted) return;
		DEBUG_LOG_ENABLED && workerLogger.info(`[Worker Thread:${workerId}] Exited with code ${code}`);

		// HANDLE HELPER EXIT ---
		// If helper dies, clean up map and update primary about reduced capacity.
		if (isHelper && workers) {
			try {
				const info = workers.get(workerId);
				if (info?.type === 'helper') {
					workers.delete(workerId);
					if (!info.terminating && workerState) {
						workerState.helperCount = Math.max(0, workerState.helperCount - 1);
						process.send?.({ type: 'helper_count_update', helperCount: workerState.helperCount });
					}
				}
			} catch (e) {
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker Thread:${workerId}] Error handling helper exit: ${e.message}`);
			}
		}

		// HANDLE TASK RESTART ---
		// Background tasks are critical; restart them if they crash unexpectedly.
		if (code !== 0 && workers && !isHelper) {
			setTimeout(() => {
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker Thread:${workerId}] Restarting...`);
				try {
					if (workers.has(workerId)) {
						workers.set(workerId, { ...workers.get(workerId), worker: createWorkerThread(workerId, taskName, isHelper, workers, workerState), lastPing: Date.now() });
						DEBUG_LOG_ENABLED && workerLogger.info(`[Worker Thread:${workerId}] Successfully restarted`);
					}
				} catch (e) {
					DEBUG_LOG_ENABLED && workerLogger.info(`[Worker Thread:${workerId}] Failed to restart: ${e.message}`);
				}
			}, 1000);
		}
	});
	return worker;
}

// SCALING LOGIC ---------------------------------------------------------------
// Manages dynamic pool of helper threads based on load.
// invoked via control-plane messages from the primary process.
// Steps: on scale_up create helper if under cap, on scale_down terminate one helper, on overload_status toggle local overload gate for task worker.
async function handleScaling(msg, workers, state) {
	if (msg.type === 'scale_up' && state.helperCount < CONFIG.MAX_HELPERS / 2) {
		const id = `helper-${Date.now()}-${state.helperCount}`;
		try {
			workers.set(id, buildWorkerThreadInfo({ workerThread: createWorkerThread(id, null, true, workers, state), type: WORKER_THREAD_TYPES.helper, lastPing: Date.now() }));
			state.helperCount++;
			process.send?.({ type: 'helper_count_update', helperCount: state.helperCount });
			DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Added helper ${id}`);
		} catch (e) {
			DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Failed to create helper: ${e.message}`);
		}
	} else if (msg.type === 'scale_down' && state.helperCount > 0) {
		const helperEntry = Array.from(workers.entries()).find(([, workerInfo]) => workerInfo.type === WORKER_THREAD_TYPES.helper);
		if (helperEntry) {
			const [id, info] = helperEntry as [string, any];
			try {
				workers.set(id, { ...info, terminating: true });
				await info.worker.terminate();
				workers.delete(id);
				state.helperCount--;
				process.send?.({ type: 'helper_count_update', helperCount: state.helperCount });
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Removed helper ${id}`);
			} catch (e) {
				DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Failed to terminate helper: ${e.message}`);
			}
		}
	} else if (msg.type === 'overload_status') {
		state.isTaskWorkerOverloaded = msg.isOverloaded;
		if (state.workerId === CONFIG.TASK_WORKER_ID)
			DEBUG_LOG_ENABLED && workerLogger.info(`[Worker:${process.pid}] Task overload ${msg.isOverloaded ? 'detected - throttling enabled' : 'resolved - throttling disabled'}`);
	}
}

// MAIN WORKER INITIALIZATION ---------------------------------------------------
// Bootstraps a worker process: Express + middleware + optional Socket.IO + optional task threads.
// Only the designated TASK_WORKER_ID spawns background task threads.
// Steps: create http server + app, enable CBOR if configured, install overload gate, setup middleware, attach error handler, attach sockets, spawn tasks if task worker, then listen.
export async function initializeWorker() {
	const workerId = process.env.WORKER_ID;
	const isTaskWorker = workerId === CONFIG.TASK_WORKER_ID;

	logSection(isTaskWorker ? 'Initializing Task Worker' : 'Initializing HTTP Worker');

	const app = express();
	const server = http.createServer(app);
	const workers = new Map();
	const state = { helperCount: 0, workerId, isTaskWorkerOverloaded: false };

	httpServerRef = server;
	workerThreadsRef = workers;
	logStep('Express app created');

	// TRACK SOCKETS FOR FAST SHUTDOWN ---
	// Force-close all open sockets during shutdown so the process can exit quickly.
	server.on('connection', socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});

	// CONFIG & MIDDLEWARE ---
	// Apply CBOR optimization, overload gate, then the full middleware stack.
	if (ENABLE_CBOR) enhanceResponseWithCbor();
	app.use((req, res, next) => {
		if (state.workerId === CONFIG.TASK_WORKER_ID && state.isTaskWorkerOverloaded)
			return res.status(503).set('Retry-After', '10').json({ error: 'taskWorkerOverloaded', message: 'High load, retry later.' });
		next();
	});
	logStep('Setting up middleware');
	setupMiddleware(app, backendDir);
	logStep('Middleware configured');

	// ERROR HANDLING ---
	// Last-resort Express error handler. Must never throw; always returns a response if possible.
	// eslint-disable-next-line no-unused-vars
	app.use((err, req, res, next) => {
		expressErrorLogger.error('express.unhandled_error', { req, status: res.statusCode, requestId: req.requestId, error: err });
		Catcher({ origin: 'App.js', error: err, res, req });
		if (!res.headersSent) res.status(503).json({ error: 'serverError', message: 'Unexpected error' });
	});

	process.on('message', msg => handleScaling(msg, workers, state));

	try {
		// SOCKET.IO SETUP ---
		// In cluster mode, Socket.IO attaches to the shared HTTP server.
		// In MIN_MODE, a dedicated socket-only port can be used.
		logStep('Configuring Socket.IO', MIN_MODE ? 'dedicated port' : 'shared server');
		if (!MIN_MODE) {
			await Socket(server);
		} else {
			const sockPort = Number(process.env.SOCKET_PORT || Number(process.env.BE_PORT || 2208) + 1);
			if (sockPort) {
				(socketOnlyServerRef = http.createServer()).listen(sockPort, '0.0.0.0', () => {
					logSubsystemReady('Socket.IO', `port ${sockPort}`);
				});
				await Socket(socketOnlyServerRef);
				socketOnlyServerRef.on('connection', socket => {
					sockets.add(socket);
					socket.on('close', () => sockets.delete(socket));
				});
			}
		}

		// BACKGROUND TASKS ---
		// Only the designated "Task Worker" runs background jobs.
		if (isTaskWorker) {
			logStep('Spawning task threads', TASK_THREAD_NAMES.join(', '));
			for (const { id, taskName } of [
				{ id: 'chatTasks', taskName: 'chatTasks' },
				{ id: 'contentTasks', taskName: 'contentTasks' },
				{ id: 'hourlyRecalc', taskName: 'hourlyRecalc' },
				{ id: 'dailyRecalc', taskName: 'dailyRecalc' },
			]) {
				try {
					workers.set(id, buildWorkerThreadInfo({ workerThread: createWorkerThread(id, taskName, false, workers), type: WORKER_THREAD_TYPES.task, taskName, lastPing: Date.now() }));
				} catch (e) {
					workerLogger.error(`Failed creating task ${id}`, { error: e });
					throw e;
				}
			}
		}

		// START SERVER ---
		// Start listening only after middleware + optional sockets + optional tasks are initialized.
		const port = Number(process.env.BE_PORT || 2208);
		logStep('Starting HTTP server', `port ${port}`);
		server.listen(port, '0.0.0.0', () => {
			logSubsystemReady('HTTP Server', `port ${port}`);
			process.send?.({ type: 'worker_ready', workerId: state.workerId });
		});
	} catch (e) {
		workerLogger.error('Worker initialization failed', { error: e, pid: process.pid });
		process.exit(1);
	}
}

// SHUTDOWN HANDLING -----------------------------------------------------------
// Attempts graceful shutdown: close sockets, stop servers, terminate threads, close DB/Redis.
// In dev MIN_MODE, prefers instant exit to maximize iteration speed.
// Steps: guard against double-run, destroy open sockets, in dev exit immediately; in prod close DB/redis, stop servers, terminate threads, then disconnect cluster with a hard timeout failsafe.
export function gracefulShutdown(signal) {
	if (shutdownStarted) return;
	shutdownStarted = true;
	shutdownLogger.info(`[${process.pid}] Received ${signal}, starting shutdown...`);

	const close = server => new Promise<void>(resolve => server?.close?.(() => resolve()) || resolve());
	const killThreads = async () =>
		Promise.all(Array.from((workerThreadsRef || new Map()).values()).map(async (info: any) => info.worker?.terminate?.().catch(e => console.error(`Terminating thread error: ${e.message}`))));

	// Force close active connections to allow fast restart
	for (const socket of sockets) {
		(socket as any).destroy();
		sockets.delete(socket);
	}

	// FAST EXIT IN DEV MODE ---------------------------------------------------
	// In development, we skip graceful cleanup of DB/Redis/Threads
	// to ensure instant restarts. process.exit() cleans up resources anyway.
	if (DEBUG_LOG_ENABLED) {
		shutdownLogger.info(`[${process.pid}] Dev shutdown: force exiting immediately.`);
		process.exit(0);
	}

	(async () => {
		try {
			await Sql?.end?.().catch(e => console.warn('DB close failed', e));
			// Also try to close replica if it exists
			try {
				const mysqlModule = await import('../systems/mysql/mysql.js');
				await mysqlModule?.SqlRead?.end?.();
			} catch {}

			await Redis?.shutDown?.().catch(e => console.warn('Redis close failed', e));
			await Promise.all([close(httpServerRef), close(socketOnlyServerRef), close(global.stickyServerRef), killThreads()]);

			if (cluster.isPrimary) {
				const f = setTimeout(() => {
					console.error(`[${process.pid}] Force exiting primary after timeout`);
					process.exit(1);
				}, FORCE_SHUTDOWN_MS);
				cluster.disconnect(() => {
					clearTimeout(f);
					console.log(`[${process.pid}] Cluster disconnected. Exiting.`);
					process.exit(0);
				});
			} else {
				process.exitCode = 0;
				setTimeout(() => process.exit(0), 500);
			}
		} catch (e) {
			console.error(`[${process.pid}] Shutdown error:`, e);
			process.exit(1);
		}
	})();
}

// PROCESS-LEVEL FAILSAFE --------------------------------------------------------
// Converts fatal events into a controlled shutdown sequence. Always enforces a hard timeout.
if (cluster.isWorker) {
	process.on('disconnect', () => {
		DEBUG_LOG_ENABLED && shutdownLogger.info(`[Worker:${process.pid}] IPC disconnected, shutting down`);
		gracefulShutdown('disconnect');
	});
}

['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(evt =>
	process.on(evt, e => {
		if (e instanceof Error) {
			shutdownLogger.error(evt, { error: e });
			DEBUG_LOG_ENABLED && shutdownLogger.info(`${evt.toUpperCase()}: ${e.message}`);
		}
		gracefulShutdown(evt);
		// Failsafe exit if graceful shutdown hangs
		setTimeout(
			() => {
				DEBUG_LOG_ENABLED && shutdownLogger.info(`[${process.pid}] Failsafe timeout reached, force exiting.`);
				process.exit(1);
			},
			DEBUG_LOG_ENABLED ? 2000 : FORCE_SHUTDOWN_MS
		);
	})
);
