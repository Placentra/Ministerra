// CLUSTER PRIMARY MANAGER ---
// Orchestrates worker lifecycle, health monitoring, and dynamic scaling logic
// Centralizes cluster-wide state and translates worker metrics into actionable scaling events

import cluster from 'cluster';
import { CONFIG, DEBUG_LOG_ENABLED } from '../startup/config';
import {
	clusterWorkersReadyGauge,
	clusterHelpersTotalGauge,
	clusterTaskOverloadedGauge,
	clusterWorkerBacklogGauge,
	clusterWorkerProcessingMsGauge,
	clusterWorkerCpuUsagePercentGauge,
} from '../startup/metrics';
import { getLogger } from '../systems/handlers/logging/index';
import { handleSubsystemReady, logStartupComplete } from './readiness';

const primaryLogger = getLogger('Primary');

// STATE MANAGEMENT ---
// Tracks readiness, helper distribution, and overload windows to stabilize scaling
export const primaryState = {
	workerStatus: new Map(), // workerId -> { isReady, lastStatusUpdate, metrics }
	helperCounts: new Map(), // workerId -> helperCount
	totalHelpers: 0,
	lastScaleAction: 0,
	overloadStartTime: 0,
	lastOverloadResolvedTime: 0,
	isTaskWorkerOverloaded: false,
	workersReady: 0,
	totalWorkers: 0,
};

// WORKER IDENTITY RESOLUTION ---
// Steps: prefer explicit workerId in message (stable across forks), otherwise fall back to cluster worker.id.
function resolveWorkerId(worker, message) {
	return message?.workerId ? String(message.workerId) : String(worker.id);
}

// INBOUND MESSAGE DISPATCH ---
// Steps: treat worker messages as control-plane signals, resolve stable workerId, then route to the specific handler by message.type.
export function handleWorkerMessage(worker, message) {
	// Filter out internal/library messages that don't follow our protocol (e.g. Socket.IO adapter messages)
	if (!message || typeof message !== 'object' || !message.type) return;

	const workerId = resolveWorkerId(worker, message);
	switch (message.type) {
		case 'worker_ready':
			handleWorkerReady(workerId);
			break;
		case 'subsystem_ready':
			handleSubsystemReady(workerId, message.subsystem);
			break;
		case 'worker_status':
			handleWorkerStatus(workerId, message);
			break;
		case 'helper_count_update':
			handleHelperCountUpdate(workerId, message.helperCount);
			break;
		default:
			DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Unknown message type: ${message.type} from worker ${workerId}`, { message });
			break;
	}
}

// READINESS ACKNOWLEDGMENT ---
// Steps: flip isReady once, increment workersReady gauge, and keep logs deterministic for startup diagnosis.
function handleWorkerReady(workerId) {
	const status = primaryState.workerStatus.get(workerId);
	if (!status) {
		DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] ERROR: No status for "${workerId}". Known: [${Array.from(primaryState.workerStatus.keys()).join(', ')}]`);
		return;
	}
	if (!status.isReady) {
		(status.isReady = true), primaryState.workersReady++;
		clusterWorkersReadyGauge.set(primaryState.workersReady);
		if (primaryState.workersReady === primaryState.totalWorkers) logStartupComplete();
	}
}

// TELEMETRY AGGREGATION ---
// Steps: ingest periodic status snapshots, update per-worker gauges, and update overload state only for the task worker.
function handleWorkerStatus(workerId, message) {
	const status = primaryState.workerStatus.get(workerId);
	if (!status) return;
	status.lastStatusUpdate = Date.now();
	if (message.tasksMetrics) {
		status.metrics = { backlog: message.tasksMetrics.taskBacklog || 0, processingTime: message.tasksMetrics.taskProcessingTime || 0, cpuUsage: message.cpuPercent || 0 };
		clusterWorkerBacklogGauge.set({ worker_id: workerId }, status.metrics.backlog);
		clusterWorkerProcessingMsGauge.set({ worker_id: workerId }, status.metrics.processingTime);
		clusterWorkerCpuUsagePercentGauge.set({ worker_id: workerId }, status.metrics.cpuUsage);
	}
	if (workerId === CONFIG.TASK_WORKER_ID) updateTaskWorkerOverloadStatus(status.metrics);
}

// HELPER POOL TRACKING ---
// Steps: update helper counts per worker, recompute totalHelpers, and publish to cluster metric gauge.
function handleHelperCountUpdate(workerId, helperCount) {
	const previousCount = primaryState.helperCounts.get(workerId) || 0;
	primaryState.helperCounts.set(workerId, helperCount);
	primaryState.totalHelpers = Array.from(primaryState.helperCounts.values()).reduce((sum, count) => sum + count, 0);
	clusterHelpersTotalGauge.set(primaryState.totalHelpers);
	if (helperCount !== previousCount) DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Worker ${workerId} helpers: ${helperCount} (Total: ${primaryState.totalHelpers})`);
}

// OVERLOAD DETECTION ---
// Steps: compare task-worker metrics against thresholds, broadcast overload status changes to all workers, and publish a single binary gauge.
function updateTaskWorkerOverloadStatus(metrics) {
	const now = Date.now(),
		isCurrentlyOverloaded = metrics.backlog >= CONFIG.TASK_BACKLOG_THRESHOLD || metrics.processingTime > CONFIG.PROCESSING_TIME_THRESHOLD;
	if (isCurrentlyOverloaded && !primaryState.isTaskWorkerOverloaded) {
		(primaryState.isTaskWorkerOverloaded = true), (primaryState.overloadStartTime = now);
		DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Overload detected (${metrics.backlog}, ${metrics.processingTime}ms)`);
		clusterTaskOverloadedGauge.set(1);
		for (const id in cluster.workers) cluster.workers[id]?.send({ type: 'overload_status', isOverloaded: true });
	} else if (!isCurrentlyOverloaded && primaryState.isTaskWorkerOverloaded) {
		(primaryState.isTaskWorkerOverloaded = false), (primaryState.lastOverloadResolvedTime = now);
		DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Overload resolved after ${Math.round((now - primaryState.overloadStartTime) / 1000)}s`);
		clusterTaskOverloadedGauge.set(0);
		for (const id in cluster.workers) cluster.workers[id]?.send({ type: 'overload_status', isOverloaded: false });
	}
}

// SCALING ORCHESTRATION ---
// Steps: enforce cooldown, then scale up on sustained overload, otherwise scale down only after a stable quiet window.
export function checkWorkersAndScale() {
	const now = Date.now();
	if (now - primaryState.lastScaleAction < CONFIG.SCALING_COOLDOWN) return;
	if (shouldScaleUp()) scaleUp();
	else if (shouldScaleDown()) scaleDown();
}

// SCALING DECISION LOGIC ---
// Steps: keep predicates pure so scaling logic is auditable and threshold changes are isolated to config.
function shouldScaleUp() {
	return primaryState.isTaskWorkerOverloaded && primaryState.totalHelpers < CONFIG.MAX_HELPERS && Date.now() - primaryState.overloadStartTime >= CONFIG.SUSTAINED_OVERLOAD_DURATION;
}
function shouldScaleDown() {
	if (primaryState.isTaskWorkerOverloaded || primaryState.totalHelpers <= CONFIG.MIN_HELPERS || !primaryState.lastOverloadResolvedTime) return false;
	return Date.now() - primaryState.lastOverloadResolvedTime >= CONFIG.STABLE_PERIOD_BEFORE_SCALE_DOWN;
}

// CAPACITY ADJUSTMENT ---
// Steps: choose a target worker based on helper count + cpu (and staleness penalty), then send scale_up/scale_down control message.
function scaleUp() {
	let targetWorker = null,
		bestScore = null;
	const STALE_MS = CONFIG.MONITORING_INTERVAL * 2;
	for (const [workerId, helperCount] of primaryState.helperCounts.entries()) {
		if (workerId === CONFIG.TASK_WORKER_ID) continue;
		const status = primaryState.workerStatus.get(workerId),
			isStale = !status || Date.now() - (status.lastStatusUpdate || 0) > STALE_MS;
		const cpu = status?.metrics?.cpuUsage ?? 0,
			score = [helperCount, cpu + (isStale ? 1000 : 0)];
		if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
			(bestScore = score), (targetWorker = workerId);
		}
	}
	if (targetWorker) {
		const worker = Object.values(cluster.workers).find(w => String(w.id) === targetWorker);
		if (worker) {
			worker.send({ type: 'scale_up' }), (primaryState.lastScaleAction = Date.now());
			DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Scaling up worker ${targetWorker} (${bestScore[0]} helpers, ${Math.round(bestScore[1])}% cpu)`);
		}
	}
}
function scaleDown() {
	let targetWorker = null,
		maxHelpers = -1;
	for (const [workerId, helperCount] of primaryState.helperCounts.entries())
		if (helperCount > maxHelpers && helperCount > 0) {
			(targetWorker = workerId), (maxHelpers = helperCount);
		}
	if (targetWorker) {
		const worker = Object.values(cluster.workers).find(w => String(w.id) === targetWorker);
		if (worker) {
			worker.send({ type: 'scale_down' }), (primaryState.lastScaleAction = Date.now());
			DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Scaling down worker ${targetWorker} (${maxHelpers} helpers)`);
		}
	}
}

// CRASH RECOVERY ---
// Steps: track recent crash timestamps per workerId; if crashes are rapid, delay restart to avoid cascade thrash; otherwise restart immediately.
const restartTimers = new Map();
export function handleWorkerExit(worker, code, signal) {
	const workerId = String(worker.id),
		isTaskWorker = workerId === CONFIG.TASK_WORKER_ID;
	if (!worker.exitedAfterDisconnect) {
		const now = Date.now(),
			times = restartTimers.get(workerId) || [],
			recent = times.filter(t => now - t < 60000);
		recent.push(now), restartTimers.set(workerId, recent);
		DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] Worker ${workerId} died (${code}, ${signal}). Recent: ${recent.length}`);
		if (recent.length > 5) {
			DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] 🛑 Rapid crash detected for ${workerId}. Cooling down...`);
			setTimeout(() => restartWorker(workerId, isTaskWorker), 30000);
		} else restartWorker(workerId, isTaskWorker);
	}
}

// WORKER REINCARNATION ---
// Steps: fork a new worker with same WORKER_ID, reset local state so metrics and readiness tracking remain coherent.
function restartWorker(workerId, isTaskWorker) {
	const newWorker = cluster.fork({ WORKER_ID: workerId });
	primaryState.workerStatus.set(workerId, { isReady: false, lastStatusUpdate: 0, metrics: { backlog: 0, processingTime: 0, cpuUsage: 0 } });
	primaryState.helperCounts.set(workerId, 0);
	if (isTaskWorker) DEBUG_LOG_ENABLED && primaryLogger.info(`[Primary] ⚠️ Task worker replaced! PID: ${newWorker.process.pid}`);
	primaryState.totalHelpers = Array.from(primaryState.helperCounts.values()).reduce((sum, count) => sum + count, 0);
}

// STARTUP VERIFICATION ---
// Steps: after a short grace window, log which workers are still pending so operators can identify stuck boots.
export function checkStartupCompletion() {
	if (primaryState.workersReady === primaryState.totalWorkers) return;
	const pendingWorkers = [];
	for (const [workerId, status] of primaryState.workerStatus.entries()) if (!status.isReady) pendingWorkers.push(workerId);
	// Only log if there are stuck workers after the grace period
	if (pendingWorkers.length > 0) primaryLogger.alert(`${pendingWorkers.length} workers still pending after 10s: ${pendingWorkers.join(', ')}`);
}
