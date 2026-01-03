// WORKER THREAD ORCHESTRATOR ---------------------------------------------------
// Executes scheduled background tasks using a single-threaded scheduler model.
// Supports helper threads that pick up overdue work with a distributed lock.

import { parentPort, workerData } from 'worker_threads';
import { Sql, Redis } from '../systems.ts';
import { getLogger } from '../handlers/loggers.ts';
import { WORKER_THREAD_CONFIG } from '../../startup/config.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

// TASK MODULE IMPORTS ----------------------------------------------------------
/** chat tasks */
import chatMessages from '../../tasks/chatMessages.ts';
import lastSeenMess from '../../tasks/lastSeenMess.ts';

/** content tasks */
import flagChanges from '../../tasks/flagChanges.ts';
import userInteractions from '../../tasks/userInteractions.ts';
import comments from '../../tasks/comments.ts';
import invites from '../../tasks/invites.ts';

/** recalc tasks */
import dailyRecalc from '../../tasks/dailyRecalc/index.ts';
import hourlyRecalc from '../../tasks/hourlyRecalc.ts';
import { Emitter } from '../handlers/emitter.ts';

const logger = getLogger('WorkerThread');
const ENABLE_WORKER_MONITORING = process.env.ENABLE_WORKER_MONITORING ? process.env.ENABLE_WORKER_MONITORING !== '0' : process.env.LIGHT_MODE !== '1';

// TASK SCHEDULE CONFIG ---------------------------------------------------------
// interval: cadence target for each task (nextRun is set based on lastRun + interval)
// timeout: hard execution cap to prevent wedged tasks from blocking scheduler forever
// priority: lower number => run first when multiple tasks are due at the same tick
const TASKS = {
	chatMessages: {
		interval: 2000,
		timeout: 15000,
		streamName: 'chatMessages',
		process: chatMessages,
		type: 'chatTasks',
		priority: 1,
	},
	lastSeenMess: {
		interval: 5000,
		timeout: 25000,
		streamName: 'lastSeenMess',
		process: lastSeenMess,
		type: 'chatTasks',
		priority: 2,
	},
	comments: {
		interval: 20000,
		timeout: 45000,
		streamName: 'eveComments',
		process: comments,
		type: 'contentTasks',
		priority: 2,
	},
	invites: {
		interval: 60000,
		timeout: 30000,
		streamName: 'newInvites',
		process: invites,
		type: 'contentTasks',
		priority: 3,
	},
	userInteractions: {
		interval: 30000,
		timeout: 60000,
		process: userInteractions,
		type: 'contentTasks',
		priority: 2,
	},
	flagChanges: {
		interval: 60000,
		timeout: 60000,
		streamName: 'flagChanges',
		process: flagChanges,
		type: 'contentTasks',
		priority: 3,
	},
	hourlyRecalc: {
		interval: 60 * 60000,
		timeout: 10 * 60000,
		process: hourlyRecalc,
		type: 'hourlyRecalc',
		priority: 3,
	},
	dailyRecalc: {
		interval: 24 * 60 * 60000,
		timeout: 2 * 60 * 60000,
		isDailyTask: true,
		process: dailyRecalc,
		type: 'dailyRecalc',
		priority: 3,
	},
};

// TASK TYPE ROUTING ------------------------------------------------------------
const TASK_TYPE_MAPPING = {
	chatTasks: Object.entries(TASKS)
		.filter(([, config]) => config.type === 'chatTasks')
		.map(([name]) => name),
	contentTasks: Object.entries(TASKS)
		.filter(([, config]) => config.type === 'contentTasks')
		.map(([name]) => name),
	hourlyRecalc: ['hourlyRecalc'],
	dailyRecalc: ['dailyRecalc'],
};

// WORKER THREAD CONFIG ---------------------------------------------------------
// Centralized defaults imported from startup/config to keep overload thresholds
// consistent with the primary scaling logic.
const CONFIG = WORKER_THREAD_CONFIG;

// RUNTIME STATE ----------------------------------------------------------------
const state = {
	// Core worker info
	workerId: workerData?.workerId || `worker-${Date.now()}`,
	taskType: workerData?.taskName || null,
	isHelper: workerData?.isHelper || false,
	initialized: false,

	// Processing state
	isProcessing: false,
	currentTaskName: null,

	// Connections
	redis: null,
	con: null,

	// Timers
	taskTimer: null,
	monitoringTimer: null,
	statusTimer: null,
	heartbeatTimer: null,

	// Metrics - simplified and focused
	metrics: {
		tasksExecuted: 0,
		totalProcessingTime: 0,
		avgProcessingTime: 0,
		backlogCount: 0, // Actual missed executions
		lastStatusReport: 0,
		taskHistory: new Map(), // taskName -> Array of recent execution times
	},

	// Circuit breakers per task
	circuitBreakers: new Map(), // taskName -> { state: 'closed'|'open'|'half', failures: 0, openedAt: 0, nextTryAt: 0 }

	// Task scheduling - cleaner approach
	schedule: new Map(), // taskName -> { nextRun, lastRun, consecutiveMisses }

	// System monitoring
	system: {
		cpuUsage: 0,
		memoryUsage: 0,
		lastCpuCheck: process.cpuUsage(),
	},
};

// PARENT PORT HANDLERS ---------------------------------------------------------
// Named handlers make error handling explicit and keep comments enforceable.
parentPort.on('message', message => handleParentPortMessage(message));
parentPort.on('close', () => handleParentPortClose());

// PARENT PORT MESSAGE DISPATCH -------------------------------------------------
async function handleParentPortMessage(message) {
	try {
		// CONTROL MESSAGE ROUTING -------------------------------------------------
		// Keep worker control-plane predictable; never throw past this boundary.
		if (message.type === 'initialize') return await handleInitialize(message);
		if (message.type === 'shutdown') return await shutdown('message');
		if (message.type === 'status') return reportStatus();
		log(`Unknown message type: ${message.type}`, 'warn');
	} catch (error) {
		sendError(error instanceof Error ? error : new Error(String(error)));
	}
}

// PARENT PORT CLOSE HANDLING ---------------------------------------------------
function handleParentPortClose() {
	log('Parent port closed, shutting down');
	shutdown('parentPortClose').catch(error => sendError(error instanceof Error ? error : new Error(String(error))));
}

// IPC SEND ---------------------------------------------------------------------
function sendMessage(type, data = {}) {
	parentPort.postMessage({
		type,
		workerId: state.workerId,
		taskType: state.taskType,
		timestamp: Date.now(),
		...data,
	});
}

// IPC ERROR --------------------------------------------------------------------
function sendError(error) {
	sendMessage('error', {
		error: error.message,
		stack: error.stack,
		context: {
			currentTask: state.currentTaskName,
			isProcessing: state.isProcessing,
		},
	});
}

// LOGGING ----------------------------------------------------------------------
function log(message, level = 'info', meta = {}) {
	const baseMeta = {
		workerId: state.workerId,
		taskType: state.taskType,
		isHelper: state.isHelper,
		isProcessing: state.isProcessing,
		...meta,
	};

	switch (level) {
		case 'error':
			logger.error(message, baseMeta);
			break;
		case 'warn':
			logger.alert(message, baseMeta);
			break;
		case 'success':
			logger.info(message, { ...baseMeta, status: 'success', __skipRateLimit: true });
			break;
		default:
			logger.info(message, { ...baseMeta, __skipRateLimit: true });
	}
}

// INITIALIZATION ---------------------------------------------------------------
async function handleInitialize(message) {
	if (state.initialized) return;

	try {
		// STATE SYNC --------------------------------------------------------------
		// Bind worker identity and role early; later logs/metrics depend on it.
		// Update state from message
		Object.assign(state, {
			workerId: message.workerId || state.workerId,
			taskType: message.taskName || state.taskType,
			isHelper: message.isHelper || state.isHelper,
		});

		// NOTE: Removed per-worker init log - "Worker initialized" log is sufficient

		// CONNECTION WARMUP -------------------------------------------------------
		// Fail fast on infra issues; scheduler assumes redis+sql are ready.
		// Establish connections with retries
		await ensureConnections();

		// ROLE STARTUP ------------------------------------------------------------
		// Task workers schedule their cadence; helpers opportunistically assist.
		// Initialize task scheduling
		if (!state.isHelper && state.taskType) {
			await initializeTaskSchedule();
			startTaskProcessing();
		} else if (state.isHelper) {
			startHelperMode();
		}

		// TELEMETRY ---------------------------------------------------------------
		// Monitoring is optional (light mode), but when enabled it feeds autoscaling.
		// Start monitoring
		if (ENABLE_WORKER_MONITORING) startMonitoring();

		state.initialized = true;
		log(`Thread ${state.taskType} ready`, 'success');
		sendMessage('initialized');
	} catch (error) {
		log(`Initialization failed: ${error.message}`, 'error');
		sendError(error);

		// INITIALIZATION RETRIES --------------------------------------------------
		// Backoff retries reduce thundering herds during cold starts or DB flaps.
		// Retry limited times with backoff before giving up
		try {
			let attempt = 1;
			while (!state.initialized && attempt <= CONFIG.MAX_RETRIES) {
				const delay = CONFIG.BASE_RETRY_DELAY * Math.pow(2, attempt);
				log(`Retrying initialization in ${delay}ms (attempt ${attempt}/${CONFIG.MAX_RETRIES})`, 'warn');
				await new Promise(r => setTimeout(r, delay));
				try {
					await ensureConnections();
					if (!state.isHelper && state.taskType) {
						await initializeTaskSchedule();
						startTaskProcessing();
					} else if (state.isHelper) {
						startHelperMode();
					}
					if (ENABLE_WORKER_MONITORING) startMonitoring();
					state.initialized = true;
					sendMessage('initialized');
					log(`Worker initialized successfully after retry`, 'success');
					break;
				} catch (e) {
					log(`Retry ${attempt} failed: ${e.message}`, 'error');
				}
				attempt++;
			}
		} catch (retryErr) {
			log(`Fatal initialization retry error: ${retryErr.message}`, 'error');
		}
	}
}

// TASK SCHEDULE INIT -----------------------------------------------------------
async function initializeTaskSchedule() {
	const taskNames = TASK_TYPE_MAPPING[state.taskType];
	if (!taskNames) {
		throw new Error(`Unknown task type: ${state.taskType}`);
	}

	// BOOTSTRAP NEXT-RUN ---------------------------------------------------------
	// Use redis last-finished timestamps so restarts don't double-run work.
	// Pre-execution check in executeTask() re-verifies to prevent races with cacher.
	const now = Date.now();
	const lastExecutions = (await state.redis.hgetall(REDIS_KEYS.tasksFinishedAt)) || {};
	for (const taskName of taskNames) {
		const taskConfig = TASKS[taskName];
		const lastRun = parseInt(lastExecutions[taskName] || '0');
		const timeSinceLastRun = lastRun > 0 ? now - lastRun : 0;
		// Schedule normally; executeTask() will re-check Redis before running
		const nextRun = lastRun === 0 || timeSinceLastRun >= taskConfig.interval ? now + 5000 + Math.random() * 2000 : lastRun + taskConfig.interval;
		state.schedule.set(taskName, { nextRun, lastRun: lastRun || 0, consecutiveMisses: 0 });
		state.metrics.taskHistory.set(taskName, []);
	}
}

// TASK LOOP START --------------------------------------------------------------
function startTaskProcessing() {
	// SCHEDULER TICK RATE --------------------------------------------------------
	// Tick faster than the smallest interval, but clamp to avoid busy looping.
	const intervals = TASK_TYPE_MAPPING[state.taskType].map(name => TASKS[name].interval);
	const shortIntervals = intervals.filter(interval => interval < 60000); // Don't let long intervals dictate check frequency
	const baseInterval = shortIntervals.length > 0 ? Math.min(...shortIntervals) : Math.min(...intervals);
	const actualInterval = Math.max(Math.min(baseInterval / 4, 2000), 500);

	// NOTE: Removed per-worker "starting task processing" log

	// IMPORTANT: never use an `async` setInterval callback without a catch.
	// If `processScheduledTasks()` throws, an async interval callback creates an
	// unhandled rejection which can crash the worker thread/process.
	state.taskTimer = setInterval(() => {
		if (state.isProcessing) return;
		processScheduledTasks().catch(error => {
			log(`processScheduledTasks failed: ${error?.message || error}`, 'error');
			sendError(error instanceof Error ? error : new Error(String(error)));
			// Ensure we don't deadlock the scheduler if a failure occurred before the internal finally.
			state.isProcessing = false;
		});
	}, actualInterval);
}

// TASK LOOP TICK ---------------------------------------------------------------
async function processScheduledTasks() {
	if (state.isProcessing) return;

	const now = Date.now();
	const dueTasks = [];

	for (const [taskName, schedule] of state.schedule.entries()) {
		if (now >= schedule.nextRun) {
			dueTasks.push(taskName);
		}
	}

	if (dueTasks.length === 0) return;

	dueTasks.sort((a, b) => {
		const taskA = TASKS[a];
		const taskB = TASKS[b];
		const scheduleA = state.schedule.get(a);
		const scheduleB = state.schedule.get(b);

		if (taskA.priority !== taskB.priority) {
			return taskA.priority - taskB.priority;
		}

		const overdueA = now - scheduleA.nextRun;
		const overdueB = now - scheduleB.nextRun;
		return overdueB - overdueA;
	});

	state.isProcessing = true;

	try {
		const tasksToRun = dueTasks.slice(0, CONFIG.MAX_CONCURRENT_TASKS);
		await Promise.all(tasksToRun.map(taskName => executeTask(taskName)));
	} finally {
		state.isProcessing = false;
	}
}

// TASK EXECUTION ---------------------------------------------------------------
async function executeTask(taskName) {
	const taskConfig = TASKS[taskName];
	const schedule = state.schedule.get(taskName);

	// CONFIG GUARD ---------------------------------------------------------------
	// Missing schedule/config means worker state drifted or code was changed unsafely.
	if (!taskConfig || !schedule) {
		log(`Task ${taskName} not found in configuration`, 'error');
		return;
	}

	// DUPLICATE RUN GUARD --------------------------------------------------------
	// Re-check Redis to avoid double-running tasks that cacher or another process just ran.
	const freshLastRun = parseInt((await state.redis.hget(REDIS_KEYS.tasksFinishedAt, taskName)) || '0');
	if (freshLastRun > 0 && Date.now() - freshLastRun < taskConfig.interval * 0.9) {
		schedule.lastRun = freshLastRun;
		schedule.nextRun = freshLastRun + taskConfig.interval;
		return { taskName, skipped: true, reason: 'recently_run' };
	}

	const startTime = Date.now();

	// CIRCUIT BREAKER ------------------------------------------------------------
	// Avoid tight failure loops; probe after backoff when a task keeps failing.
	// Circuit breaker: check if task is allowed
	const cb = state.circuitBreakers.get(taskName) || { state: 'closed', failures: 0, openedAt: 0, nextTryAt: 0 };
	if (cb.state === 'open' && Date.now() < cb.nextTryAt) {
		// Skip execution; schedule next probe
		schedule.nextRun = cb.nextTryAt;
		log(`Circuit breaker OPEN for ${taskName}, skipping until ${new Date(cb.nextTryAt).toISOString()}`, 'warn');
		return { taskName, skipped: true };
	} else if (cb.state === 'open' && Date.now() >= cb.nextTryAt) {
		cb.state = 'half';
		state.circuitBreakers.set(taskName, cb);
		log(`Circuit breaker HALF-OPEN probe for ${taskName}`, 'warn');
	}

	try {
		// EXECUTION ---------------------------------------------------------------
		// Enforce timeout so a single task cannot wedge the scheduler.
		await ensureConnections();
		state.currentTaskName = taskName;
		const result = await withTimeout(taskConfig.process(state.con, state.redis), taskConfig.timeout || CONFIG.DEFAULT_TASK_TIMEOUT);

		const endTime = Date.now();
		const processingTime = endTime - startTime;

		// SCHEDULE ADVANCE --------------------------------------------------------
		// Use endTime to prevent drift accumulation when tasks take long to run.
		schedule.lastRun = endTime;
		schedule.nextRun = endTime + taskConfig.interval;
		schedule.consecutiveMisses = 0;

		// CIRCUIT BREAKER SUCCESS -------------------------------------------------
		// Circuit breaker: on success
		const succCb = state.circuitBreakers.get(taskName) || { state: 'closed', failures: 0, openedAt: 0, nextTryAt: 0 };
		succCb.failures = 0;
		succCb.state = 'closed';
		succCb.openedAt = 0;
		succCb.nextTryAt = 0;
		state.circuitBreakers.set(taskName, succCb);

		// PERSIST LAST FINISH -----------------------------------------------------
		// Primary/other workers rely on this for restart scheduling and helper assistance.
		await state.redis.hset(REDIS_KEYS.tasksFinishedAt, taskName, endTime.toString());

		// METRICS -----------------------------------------------------------------
		state.metrics.tasksExecuted++;
		state.metrics.totalProcessingTime += processingTime;
		state.metrics.avgProcessingTime = state.metrics.totalProcessingTime / state.metrics.tasksExecuted;

		const history = state.metrics.taskHistory.get(taskName);
		history.push({ timestamp: endTime, processingTime });
		if (history.length > CONFIG.MAX_TASK_HISTORY) {
			history.shift();
		}

		if (result && !result.error) {
			await processTaskResults(result, taskName);
		}

		return { taskName, result, error: null };
	} catch (error) {
		// FAILURE HANDLING --------------------------------------------------------
		// Backoff and circuit breaker reduce infrastructure pressure during outages.
		log(`Task ${taskName} failed: ${error.message}`, 'error');

		schedule.consecutiveMisses++;

		if (schedule.consecutiveMisses >= 3) {
			const now = Date.now();
			schedule.lastRun = now;
			schedule.nextRun = now + taskConfig.interval;
			log(`Task ${taskName} failed 3 times, advancing schedule`, 'warn');
		} else {
			schedule.nextRun = Date.now() + 30000 + Math.floor(Math.random() * 5000);
		}

		// Circuit breaker: on failure
		const failCb = state.circuitBreakers.get(taskName) || { state: 'closed', failures: 0, openedAt: 0, nextTryAt: 0 };
		failCb.failures += 1;
		const threshold = Number(process.env.CB_FAILURE_THRESHOLD) || 5;
		if (failCb.state === 'closed' && failCb.failures >= threshold) {
			failCb.state = 'open';
			failCb.openedAt = Date.now();
			const base = Number(process.env.CB_BASE_BACKOFF_MS) || 15000;
			const max = Number(process.env.CB_MAX_BACKOFF_MS) || 5 * 60 * 1000;
			const exp = Math.min(base * 2 ** Math.min(failCb.failures - threshold, 5), max);
			failCb.nextTryAt = failCb.openedAt + exp;
			log(`Circuit breaker OPEN for ${taskName} (failures=${failCb.failures}) for ${exp}ms`, 'warn');
		}
		state.circuitBreakers.set(taskName, failCb);

		return { taskName, result: null, error };
	} finally {
		state.currentTaskName = null;
	}
}

// TASK RESULT HANDLING ---------------------------------------------------------
async function processTaskResults(result: any, taskName) {
	const emitterData: any = {};
	let hasAlerts = false;

	if (result.userRatingsMap && result.userRatingsMap.size > 0) {
		emitterData.userRatingsMap = result.userRatingsMap;
		hasAlerts = true;
	}

	if (result.commentsAlerts && result.commentsAlerts.length > 0) {
		emitterData.commentsAlerts = result.commentsAlerts;
		hasAlerts = true;
	}

	if (result.interactionsAlerts && result.interactionsAlerts.length > 0) {
		emitterData.interactionsAlerts = result.interactionsAlerts;
		hasAlerts = true;
	}

	if (result.userInvitesMap && Array.from(result.userInvitesMap.values()).some((arr: any) => (arr || []).length > 0)) {
		emitterData.userInvitesMap = result.userInvitesMap;
		hasAlerts = true;
	}

	if (hasAlerts) {
		try {
			await Emitter(emitterData, state.con, state.redis);
		} catch (error) {
			log(`Alert processing failed for ${taskName}: ${error.message}`, 'error');
		}
	}
}

// HELPER MODE START ------------------------------------------------------------
function startHelperMode() {
	log('Starting helper mode');

	// IMPORTANT: never use an `async` setInterval callback without a catch.
	state.taskTimer = setInterval(() => {
		if (state.isProcessing) return;
		checkForOverdueTasks().catch(error => log(`Helper overdue check failed: ${error?.message || error}`, 'error'));
	}, CONFIG.HELPER_CHECK_INTERVAL);
}

// HELPER OVERDUE DISCOVERY -----------------------------------------------------
async function checkForOverdueTasks() {
	try {
		const lastExecutions = (await state.redis.hgetall(REDIS_KEYS.tasksFinishedAt)) || {};
		const now = Date.now();

		let mostOverdueTask = null;
		let maxOverdueRatio = 0;

		for (const [taskName, taskConfig] of Object.entries(TASKS)) {
			const lastRun = parseInt(lastExecutions[taskName] || '0');
			if (lastRun === 0) continue;

			const timeSinceLastRun = now - lastRun;
			const overdueRatio = timeSinceLastRun / taskConfig.interval;

			const threshold = (taskConfig as any).isDailyTask ? 1.05 : 2;
			if (overdueRatio > threshold && overdueRatio > maxOverdueRatio) {
				mostOverdueTask = taskName;
				maxOverdueRatio = overdueRatio;
			}
		}

		if (mostOverdueTask) {
			log(`Helper assisting with ${mostOverdueTask} (${maxOverdueRatio.toFixed(1)}x overdue)`);
			await executeHelperTask(mostOverdueTask);
		}
	} catch (error) {
		log(`Helper task check failed: ${error.message}`, 'error');
	}
}

// HELPER EXECUTION -------------------------------------------------------------
async function executeHelperTask(taskName) {
	const taskConfig = TASKS[taskName];
	if (!taskConfig) return;

	state.isProcessing = true;

	// Token declared outside try block so finally can access it ---------------------------
	const lockKey = `worker:helper_lock:${taskName}`;
	let token;
	try {
		token = state.workerId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
		const ttl = (taskConfig.timeout || CONFIG.DEFAULT_TASK_TIMEOUT) + 5000;
		const acquired = await state.redis.set(lockKey, token, 'PX', ttl, 'NX');
		if (!acquired) {
			log(`Helper lock not acquired for ${taskName}, skipping`, 'warn');
			return;
		}
		const startTime = Date.now();

		const result = await withTimeout(taskConfig.process(state.con, state.redis), taskConfig.timeout || CONFIG.DEFAULT_TASK_TIMEOUT);

		const endTime = Date.now();
		const processingTime = endTime - startTime;

		await state.redis.hset(REDIS_KEYS.tasksFinishedAt, taskName, endTime.toString());

		if (result && !result.error) {
			await processTaskResults(result, taskName);
		}

		log(`Helper completed ${taskName} in ${processingTime}ms`);
	} catch (error) {
		log(`Helper task ${taskName} failed: ${error.message}`, 'error');
	} finally {
		// Release lock if owned (token declared above try block) ---------------------------
		if (token) {
			try {
				const lua = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
				await state.redis.eval(lua, 1, lockKey, token);
			} catch (e) {
				log(`Helper lock release failed: ${e.message}`, 'warn');
			}
		}
		state.isProcessing = false;
	}
}

// MONITORING START -------------------------------------------------------------
function startMonitoring() {
	// MONITORING TIMERS ----------------------------------------------------------
	// Separate timers keep metrics refresh and status emission decoupled.
	state.monitoringTimer = setInterval(() => {
		updateSystemMetrics();
	}, CONFIG.MONITORING_INTERVAL);

	state.statusTimer = setInterval(() => {
		reportStatus();
	}, CONFIG.STATUS_REPORT_INTERVAL);

	state.heartbeatTimer = setInterval(() => {
		sendMessage('heartbeat');
	}, CONFIG.HEARTBEAT_INTERVAL);
}

// SYSTEM METRICS ---------------------------------------------------------------
function updateSystemMetrics() {
	// CPU UTILIZATION ------------------------------------------------------------
	// Approximate CPU% within the monitoring window; bounded to 0..100.
	const currentCpuUsage = process.cpuUsage(state.system.lastCpuCheck);
	const elapsedMs = CONFIG.MONITORING_INTERVAL;
	const cpuTime = (currentCpuUsage.user + currentCpuUsage.system) / 1000;
	state.system.cpuUsage = Math.min((cpuTime / elapsedMs) * 100, 100);
	state.system.lastCpuCheck = process.cpuUsage();

	// MEMORY UTILIZATION ---------------------------------------------------------
	const memUsage = process.memoryUsage();
	state.system.memoryUsage = memUsage.heapUsed / memUsage.heapTotal;

	// BACKLOG --------------------------------------------------------------------
	calculateBacklog();
}

// BACKLOG CALC -----------------------------------------------------------------
function calculateBacklog() {
	if (!state.taskType || state.isHelper) {
		state.metrics.backlogCount = 0;
		return;
	}

	const now = Date.now();
	let backlogCount = 0;

	for (const [taskName, schedule] of state.schedule.entries()) {
		const taskConfig = TASKS[taskName];

		const overdue = now - schedule.nextRun;

		if (overdue > taskConfig.interval * 0.5) {
			backlogCount++;
		}
	}

	state.metrics.backlogCount = backlogCount;
}

// STATUS REPORT ----------------------------------------------------------------
function reportStatus() {
	const now = Date.now();

	const taskMetrics = {
		backlog: state.metrics.backlogCount,
		avgProcessingTime: state.metrics.avgProcessingTime,
		tasksExecuted: state.metrics.tasksExecuted,
		isOverloaded: isWorkerOverloaded(),
	};

	sendMessage('worker_status', {
		isOverloaded: taskMetrics.isOverloaded,
		cpuPercent: state.system.cpuUsage,
		memoryUsage: {
			heapUsedPercent: state.system.memoryUsage,
			rssInMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
		},
		tasksMetrics: {
			taskBacklog: taskMetrics.backlog,
			taskDeviation: calculateTaskDeviation(),
			taskProcessingTime: taskMetrics.avgProcessingTime,
		},
	});

	state.metrics.lastStatusReport = now;
}

// OVERLOAD PREDICATE -----------------------------------------------------------
function isWorkerOverloaded() {
	return state.metrics.backlogCount >= CONFIG.BACKLOG_THRESHOLD || state.metrics.avgProcessingTime > CONFIG.PROCESSING_TIME_THRESHOLD || state.system.cpuUsage > 85 || state.system.memoryUsage > 0.9;
}

// TASK DEVIATION ---------------------------------------------------------------
function calculateTaskDeviation() {
	let totalDeviation = 0;
	let taskCount = 0;

	for (const [taskName, history] of state.metrics.taskHistory.entries()) {
		if (history.length < 2) continue;

		const expectedInterval = TASKS[taskName].interval;
		let intervalSum = 0;

		for (let i = 1; i < history.length; i++) {
			const actualInterval = history[i].timestamp - history[i - 1].timestamp;
			intervalSum += actualInterval / expectedInterval;
		}

		totalDeviation += intervalSum / (history.length - 1);
		taskCount++;
	}

	return taskCount > 0 ? totalDeviation / taskCount : 1.0;
}

// CONNECTIONS ------------------------------------------------------------------
async function ensureConnections() {
	let attempts = 0;
	while (attempts < CONFIG.MAX_RETRIES) {
		try {
			// SQL CONNECTION -------------------------------------------------------
			if (!state.con) {
				state.con = await Sql.getConnection();
			}
			// REDIS CONNECTION -----------------------------------------------------
			if (!state.redis) {
				state.redis = await Redis.getClient();
			}
			return;
		} catch (error) {
			attempts++;
			if (attempts === CONFIG.MAX_RETRIES) throw error;
			await new Promise(r => setTimeout(r, CONFIG.BASE_RETRY_DELAY * Math.pow(2, attempts)));
		}
	}
}

// TIMEOUT WRAPPER --------------------------------------------------------------
async function withTimeout(promise, ms) {
	const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms));
	return Promise.race([promise, timeout]);
}

// TIMERS STOP ------------------------------------------------------------------
function stopAllTimers() {
	if (state.taskTimer) {
		clearInterval(state.taskTimer);
		state.taskTimer = null;
	}
	if (state.monitoringTimer) {
		clearInterval(state.monitoringTimer);
		state.monitoringTimer = null;
	}
	if (state.statusTimer) {
		clearInterval(state.statusTimer);
		state.statusTimer = null;
	}
	if (state.heartbeatTimer) {
		clearInterval(state.heartbeatTimer);
		state.heartbeatTimer = null;
	}
}

// SHUTDOWN ---------------------------------------------------------------------
async function shutdown(signal, exitCode = 0) {
	log(`Received ${signal}, shutting down gracefully`);

	stopAllTimers();

	if (state.isProcessing) {
		log('Waiting for current task to complete...');
		let attempts = 0;
		const maxAttempts = 50; // 20 seconds timeout
		while (state.isProcessing && attempts < maxAttempts) {
			await new Promise(r => setTimeout(r, 400));
			attempts++;
		}
		if (state.isProcessing) {
			log('Task did not complete in time, forcing shutdown', 'warn');
			state.isProcessing = false; // Force clear to proceed with cleanup
		}
	}

	try {
		if (state.con) {
			await state.con.release();
		}
		if (state.redis) {
			await state.redis.quit();
		}
	} catch (error) {
		log(`Cleanup error: ${error.message}`, 'error');
	}

	sendMessage('shutdown', { success: true });
	log('Shutdown complete', 'success');
	// Prefer natural exit for worker_threads: close the message port and let the
	// event loop drain. Use process.exit only as a last resort.
	try {
		process.exitCode = exitCode;
		if (parentPort && typeof parentPort.close === 'function') parentPort.close();
	} catch (e) {
		log(`Shutdown: parentPort close error: ${e.message}`, 'warn');
	}
	setTimeout(() => {
		// Last resort hard exit if something keeps the event loop alive.
		try {
			process.exit(exitCode);
		} catch (e) {
			console.error('Hard exit failed', e);
		}
	}, 2000).unref?.();
}

// SIGNAL HANDLERS --------------------------------------------------------------
process.on('SIGTERM', () => shutdown('SIGTERM').catch(error => sendError(error instanceof Error ? error : new Error(String(error)))));
process.on('SIGINT', () => shutdown('SIGINT').catch(error => sendError(error instanceof Error ? error : new Error(String(error)))));

// ERROR HANDLERS ---------------------------------------------------------------
process.on('uncaughtException', async error => {
	log(`Uncaught exception: ${error.message}`, 'error');
	sendError(error);
	await shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', async reason => {
	log(`Unhandled rejection: ${reason}`, 'error');
	sendError(new Error(`Unhandled rejection: ${reason}`));
	await shutdown('unhandledRejection', 1);
});

// EXIT CLEANUP -----------------------------------------------------------------
process.on('exit', () => {
	stopAllTimers();
	// Note: exit handler is synchronous - async release/quit won't complete
	// These are best-effort cleanup; actual cleanup should happen in shutdown()
	try {
		if (state.con && typeof state.con.destroy === 'function') {
			state.con.destroy(); // Synchronous destroy if available
		}
	} catch (err) {
		// Cannot log asynchronously here, use console.error as last resort
		console.error('Worker sync cleanup failed', err);
	}
	// Redis quit is async and won't work in exit handler - logged for awareness
});
