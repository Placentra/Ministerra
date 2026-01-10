// STARTUP READINESS TRACKER ===================================================
// Tracks subsystem initialization across workers and logs activation status.
// Workers report subsystem readiness via IPC; primary aggregates and logs.
// =============================================================================

import cluster from 'cluster';
import { getLogger } from '../systems/handlers/loggers.ts';
import { logSubsystemReady } from './startupLogger.ts';

const logger = getLogger('Startup');

// SUBSYSTEM DEFINITIONS -------------------------------------------------------
// perWorker: must be reported by all workers
// global: reported once by primary or designated worker
export const SUBSYSTEMS = {
	REDIS: { name: 'Redis Sentinel', perWorker: true },
	MYSQL_PRIMARY: { name: 'MySQL Primary', perWorker: true },
	MYSQL_REPLICA: { name: 'MySQL Replica Warmup', perWorker: true },
	SOCKET_IO: { name: 'Socket.IO', perWorker: true },
	DAILY_RECALC: { name: 'Daily Recalc', perWorker: false },
	CACHE_REBUILD: { name: 'Cache Rebuild', perWorker: false },
	TASK_THREADS: { name: 'Task Threads', perWorker: false, optional: true },
} as const;

type SubsystemKey = keyof typeof SUBSYSTEMS;

// STATE -----------------------------------------------------------------------
const workerSubsystems = new Map<string, Set<SubsystemKey>>();
const globalSubsystemsReady = new Set<SubsystemKey>();
const subsystemReadyTimes = new Map<SubsystemKey, number>();
let totalWorkers = 0;
let startupStartTime = Date.now(); // Initialize early so global subsystems have valid elapsed time

// PRIMARY-SIDE INIT -----------------------------------------------------------
export function initReadinessTracker(numWorkers: number) {
	if (!cluster.isPrimary) return;
	totalWorkers = numWorkers;

	// Timeout check - log warning if non-optional subsystems don't complete in 60s
	setTimeout(() => {
		const incomplete: string[] = [];
		for (const [key, def] of Object.entries(SUBSYSTEMS)) {
			if ((def as any).optional) continue;
			if (def.perWorker) {
				const readyCount = countWorkersWithSubsystem(key as SubsystemKey);
				if (readyCount < totalWorkers) incomplete.push(`${def.name} (${readyCount}/${totalWorkers})`);
			} else if (!globalSubsystemsReady.has(key as SubsystemKey)) {
				incomplete.push(def.name);
			}
		}
		if (incomplete.length > 0) logger.alert(`Startup incomplete after 60s: ${incomplete.join(', ')}`);
	}, 60000);
}

// COUNT WORKERS WITH SUBSYSTEM ------------------------------------------------
function countWorkersWithSubsystem(subsystem: SubsystemKey): number {
	let count = 0;
	for (const subs of workerSubsystems.values()) {
		if (subs.has(subsystem)) count++;
	}
	return count;
}

// PRIMARY-SIDE HANDLER --------------------------------------------------------
export function handleSubsystemReady(workerId: string, subsystem: SubsystemKey) {
	if (!cluster.isPrimary) return;

	const def = SUBSYSTEMS[subsystem];
	if (!def) return;

	if (def.perWorker) {
		// Track per-worker subsystem
		if (!workerSubsystems.has(workerId)) workerSubsystems.set(workerId, new Set());
		workerSubsystems.get(workerId)!.add(subsystem);

		const readyCount = countWorkersWithSubsystem(subsystem);
		if (readyCount === totalWorkers && !subsystemReadyTimes.has(subsystem)) {
			subsystemReadyTimes.set(subsystem, Date.now());
			logSubsystemReady(def.name, `all ${totalWorkers} workers`);
		}
	} else {
		// Global subsystem - log immediately
		if (!globalSubsystemsReady.has(subsystem)) {
			globalSubsystemsReady.add(subsystem);
			subsystemReadyTimes.set(subsystem, Date.now());
			logSubsystemReady(def.name);
		}
	}
}

// WORKER-SIDE REPORTER --------------------------------------------------------
export function reportSubsystemReady(subsystem: SubsystemKey) {
	const def = SUBSYSTEMS[subsystem];
	if (!def) return;

	if (cluster.isPrimary) {
		// Primary reporting for itself (global subsystems)
		handleSubsystemReady('primary', subsystem);
	} else if (process.send) {
		// Worker sending to primary
		process.send({ type: 'subsystem_ready', subsystem, workerId: process.env.WORKER_ID });
	}
}

// LOG STARTUP COMPLETE --------------------------------------------------------
export function logStartupComplete() {
	if (!cluster.isPrimary) return;
	const elapsed = Date.now() - startupStartTime;
	import('./startupLogger.ts').then(({ logCompletion }) => logCompletion(elapsed));
}
