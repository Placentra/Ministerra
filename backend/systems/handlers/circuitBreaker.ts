import { getLogger, logContext } from './loggers.ts';

const logger = getLogger('CircuitBreaker');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_SLOW_THRESHOLD_MS = 150;
const DEFAULT_SLOW_BURST = 5;
const DEFAULT_SLOW_WINDOW_MS = 10000;
const DEFAULT_SLOW_LOG_INTERVAL_MS = 2000;
const DEFAULT_COOLDOWN_MS = 30000;

// CIRCUIT BREAKER -------------------------------------------------------------

interface CircuitBreakerOptions {
	failureThreshold?: number;
	timeoutMs?: number;
	timeout?: number;
	cooldownMs?: number;
	resetTimeout?: number;
	dropOnOpen?: boolean;
	slowThresholdMs?: number;
	slowBurst?: number;
	slowWindowMs?: number;
	slowLogIntervalMs?: number;
	failureLogLevel?: string;
	fallback?: (context: any) => Promise<any> | any;
}

interface CircuitBreakerState {
	name: string;
	state: string;
	reason: string | null;
	totalRequests: number;
	totalFailures: number;
	nextProbe: string | null;
}

// CLASS DEFINITION ---
// Implements the Circuit Breaker pattern for fault tolerance and resilience.
// Tracks failures, slow queries, and manages state transitions (OPEN/CLOSED/HALF-OPEN).
class CircuitBreaker {
	name: string;
	failureThreshold: number;
	timeoutMs: number;
	cooldownMs: number;
	dropOnOpen: boolean;
	slowThresholdMs: number;
	slowBurst: number;
	slowWindowMs: number;
	slowLogIntervalMs: number;
	failureLogLevel: string;
	// unused
	fallback: ((context: any) => Promise<any> | any) | null;
	state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
	openReason: string | null;
	nextProbeTs: number;
	totalRequests: number;
	totalFailures: number;
	consecutiveFailures: number;
	recentSlowEvents: number[];
	lastSlowLogTs: number;
	lastOpenLogTs: number;
	_probeInFlight: boolean = false;

	constructor(name: string, options: CircuitBreakerOptions = {}) {
		this.name = name;

		// Failure configuration
		this.failureThreshold = options.failureThreshold ?? 5;
		this.timeoutMs = options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.cooldownMs = options.cooldownMs ?? options.resetTimeout ?? DEFAULT_COOLDOWN_MS;
		this.dropOnOpen = options.dropOnOpen ?? false;

		// Slow query configuration
		this.slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
		this.slowBurst = options.slowBurst ?? DEFAULT_SLOW_BURST;
		this.slowWindowMs = options.slowWindowMs ?? DEFAULT_SLOW_WINDOW_MS;
		this.slowLogIntervalMs = options.slowLogIntervalMs ?? DEFAULT_SLOW_LOG_INTERVAL_MS;

		// Logging configuration
		this.failureLogLevel = options.failureLogLevel || 'warn';

		// Fallback (optional)
		this.fallback = typeof options.fallback === 'function' ? options.fallback : null;

		// State tracking
		this.state = 'CLOSED';
		this.openReason = null;
		this.nextProbeTs = 0;
		this.totalRequests = 0;
		this.totalFailures = 0;
		this.consecutiveFailures = 0;

		this.recentSlowEvents = [];
		this.lastSlowLogTs = 0;
		this.lastOpenLogTs = 0;
	}

	// EXECUTE ---------------------------------------------------------------
	// Steps: enforce OPEN/HALF_OPEN gating, apply timeout, account for failure/success, track slow operations, and optionally route through fallback.
	// Main entry point. Wraps execution with:
	// - OPEN/HALF_OPEN gating
	// - timeout enforcement
	// - failure/success accounting
	// - slow-operation detection and optional fallback routing
	async execute<T>(fn: () => Promise<T>, context: any = {}): Promise<T> {
		this.totalRequests++;

		const now: number = Date.now();
		// OPEN STATE HANDLING ---
		if (this.state === 'OPEN') {
			if (now >= this.nextProbeTs) {
				// Atomic state transition: only transition if still OPEN and no probe in flight
				if (this.state === 'OPEN' && !this._probeInFlight) {
					this.state = 'HALF_OPEN';
					this._probeInFlight = true;
					logger.info(`Circuit ${this.name} probing for recovery`);
				} else {
					// Another probe is already in flight or state changed, reject this request
					if (this.dropOnOpen) {
						return this.handleOpenState(context);
					}
					this.logOpenState(now);
				}
			} else if (this.dropOnOpen) {
				return this.handleOpenState(context);
			} else {
				// Still in cooldown period - continue executing but don't count toward recovery
				this.logOpenState(now);
				// Don't execute when OPEN and not yet probe time - fallback or reject
				if (this.fallback) {
					return this.fallback(context);
				}
				// If not dropOnOpen and no fallback, proceed but this is risky
			}
		}

		const start: number = Date.now();
		try {
			// EXECUTION BLOCK ---
			const result: T = await this.runWithTimeout(fn);
			const duration: number = Date.now() - start;
			this.recordSuccess(duration, context);
			return result;
		} catch (error: any) {
			// FAILURE BLOCK ---
			const duration: number = Date.now() - start;
			if (this.shouldIgnoreError(error)) {
				throw error;
			}
			this.recordFailure(error, duration, context);

			if (this.fallback) {
				try {
					return await this.fallback(context);
				} catch (fallbackError: any) {
					logger.error(`Circuit ${this.name} fallback failed`, { error: fallbackError.message });
				}
			}

			throw error;
		}
	}

	// TIMEOUT WRAPPER --------------------------------------------------------
	// Enforces max execution duration. Rejects with a synthetic timeout error.
	// Steps: run fn() under a timer; clear timer on resolve/reject; reject with a synthetic timeout error when timer fires.
	runWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
		if (!this.timeoutMs || this.timeoutMs <= 0) {
			return Promise.resolve().then(() => fn());
		}

		return new Promise((resolve, reject) => {
			const timer: NodeJS.Timeout = setTimeout(() => reject(new Error(`${this.name} timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
			Promise.resolve()
				.then(() => fn())
				.then(
					(result: T) => {
						clearTimeout(timer);
						resolve(result);
					},
					(error: any) => {
						clearTimeout(timer);
						reject(error);
					}
				);
		});
	}

	// STATE HANDLERS ---------------------------------------------------------

	// OPEN-STATE HANDLER ------------------------------------------------------
	// Called when the circuit is OPEN and configured to drop traffic.
	// Either runs fallback or throws a CIRCUIT_OPEN error.
	// Steps: log rejection once, run fallback if configured, otherwise throw a CIRCUIT_OPEN error with retry hint.
	handleOpenState(context: any): any {
		logger.alert(`Circuit ${this.name} is OPEN (reason=${this.openReason}), rejecting request`, {
			retryAt: new Date(this.nextProbeTs).toISOString(),
		});
		const error: Error = new Error(`Circuit breaker ${this.name} is OPEN`);
		(error as any).code = 'CIRCUIT_OPEN';
		if (this.fallback) {
			return this.fallback(context);
		}
		throw error;
	}

	// SUCCESS ACCOUNTING ------------------------------------------------------
	// Resets failure counters and may close the circuit when a HALF_OPEN probe succeeds.
	// Steps: reset consecutive failures, track latency, and if this was a HALF_OPEN probe, close and clear probe-in-flight flag.
	recordSuccess(duration: number, context: any): void {
		this.consecutiveFailures = 0;
		this.trackLatency(duration, context);

		if (this.state === 'HALF_OPEN') {
			// RECOVERY LOG -------------------------------------------------------
			// Only log on recovery to avoid a high-frequency success log spam.
			let msg: string = `Circuit ${this.name} recovered (${duration}ms)`;
			if (context.sql) msg += `: ${context.sql}`;
			else if (context.command) msg += `: ${context.command} ${context.argsPreview || ''}`;
			logger.info(msg, { duration, pool: context.pool, method: context.method || context.command });
			this._probeInFlight = false;
			this.close();
		}
	}

	// FAILURE ACCOUNTING ------------------------------------------------------
	// Increments counters and opens the circuit when thresholds are exceeded.
	// Steps: increment counters, emit a failure log, track latency, and OPEN the circuit on threshold breach or lock wait timeouts.
	recordFailure(error: any, duration: number, context: any): void {
		this.totalFailures++;
		this.consecutiveFailures++;

		this.logWithLevel(this.failureLogLevel, `Circuit ${this.name} failure`, {
			state: this.state,
			failures: this.consecutiveFailures,
			error: error?.message,
		});

		this.trackLatency(duration, context, true);

		const shouldOpen: boolean = this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold || (error && (error as any).code === 'ER_LOCK_WAIT_TIMEOUT');

		if (shouldOpen) {
			this.open('errors');
		}
	}

	// ERROR & LOGGING HELPERS ------------------------------------------------

	// IGNORE ERROR ------------------------------------------------------------
	// Some errors (e.g., Redis BUSYGROUP) are expected and should not contribute to breaker state.
	// Steps: apply a narrow allowlist of ignorable errors; everything else contributes to breaker state.
	shouldIgnoreError(error: any): boolean {
		if (this.name !== 'Redis') return false;
		const msg: string = String(error?.message || error || '');
		if (!msg) return false;
		return msg.includes('BUSYGROUP') || msg.includes('Consumer Group name already exists');
	}

	// LEVEL-AWARE LOGGING -----------------------------------------------------
	// Routes through the configured logger method (warn/info/error/slow), with a silent option.
	logWithLevel(level: string, message: string, meta: any): void {
		if (level === 'silent') return;
		const logFn: any = typeof (logger as any)[level] === 'function' ? (logger as any)[level].bind(logger) : logger.alert.bind(logger);
		logFn(message, meta);
	}

	// LATENCY TRACKING --------------------------------------------------------
	// Records slow events, logs slow operations at a controlled interval, and opens the circuit
	// if slow events burst above threshold.
	// Steps: push timestamps for slow ops, trim to window, emit slow log at interval, and OPEN when burst threshold is exceeded.
	trackLatency(duration: number, context: any, failed: boolean = false): void {
		if (typeof duration !== 'number' || Number.isNaN(duration)) {
			return;
		}

		if (duration >= this.slowThresholdMs) {
			this.recentSlowEvents.push(Date.now());
			this.trimSlowEvents();
			this.logSlowQuery(duration, context, failed);

			if (this.recentSlowEvents.length >= this.slowBurst) {
				this.open('slow');
			}
		} else if (this.state === 'HALF_OPEN' && !this._probeInFlight) {
			// Fast query in HALF_OPEN indicates recovery
			this.close();
		}
	}

	// SLOW OP LOGGING ---------------------------------------------------------
	// Emits slow logs. For SQL, uses the dedicated slow channel and tags async-local context
	// so HTTP slow logging can avoid duplicating the same root-cause.
	// Steps: throttle slow logs, prefer structured SQL slow channel with request context flagging, otherwise emit generic slow alert for non-SQL.
	logSlowQuery(duration: number, context: any, failed: boolean): void {
		const now: number = Date.now();
		if (now - this.lastSlowLogTs < this.slowLogIntervalMs) {
			return;
		}

		this.lastSlowLogTs = now;
		const sqlPreview: string | undefined = context.sql ? String(context.sql).replace(/\s+/g, ' ').slice(0, 500) : undefined;

		// SLOW SQL LOGGING ------------------------------------------------------
		// Dedicated channel for slow SQL. Also mark request context so slow HTTP can be suppressed.
		if (context?.sql) {
			// CONTEXT FLAGGING ---------------------------------------------------
			// Persist the "slow SQL observed" marker when a context store exists (noop otherwise).
			Object.assign(logContext.getStore() || {}, { slowSqlObserved: true });
			logger.slow('sql.slow', {
				circuit: this.name,
				failed,
				durationMs: duration,
				pool: context.pool,
				method: context.method,
				paramsCount: context.paramsCount,
				paramsSnippet: context.paramsSnippet,
				sql: sqlPreview,
				slowEvents: this.recentSlowEvents.length,
				__skipRateLimit: true,
			});
			return;
		}

		// FALLBACK (NON-SQL) ----------------------------------------------------
		logger.alert(`Circuit ${this.name} slow operation${failed ? ' (failed)' : ''}`, {
			duration,
			state: this.state,
			method: context.method || context.command,
			argsCount: context.argsCount,
		});
	}

	// SLOW WINDOW MAINTENANCE -------------------------------------------------
	// Keeps only slow events within the current window so burst detection is time-bounded.
	trimSlowEvents(): void {
		const cutoff: number = Date.now() - this.slowWindowMs;
		while (this.recentSlowEvents.length && this.recentSlowEvents[0] < cutoff) {
			this.recentSlowEvents.shift();
		}
	}

	// STATE MANAGEMENT -------------------------------------------------------

	// OPEN CIRCUIT ------------------------------------------------------------
	// Moves the circuit to OPEN and starts cooldown before the next HALF_OPEN probe.
	// Steps: mark OPEN with reason, compute nextProbeTs, reset open log throttle, emit a single degraded alert.
	open(reason: string): void {
		this.state = 'OPEN';
		this.openReason = reason;
		this.nextProbeTs = Date.now() + this.cooldownMs;
		this.lastOpenLogTs = 0;

		logger.alert(`Circuit ${this.name} marked as degraded`, {
			reason,
			cooldownMs: this.cooldownMs,
			slowEvents: this.recentSlowEvents.length,
			failures: this.consecutiveFailures,
		});
	}

	// CLOSE CIRCUIT -----------------------------------------------------------
	// Resets state back to CLOSED after recovery.
	// Steps: clear open reason and counters, clear slow window, emit a recovery info log.
	close(): void {
		this.state = 'CLOSED';
		this.openReason = null;
		this.consecutiveFailures = 0;
		this.recentSlowEvents = [];
		logger.info(`Circuit ${this.name} recovered`);
	}

	// COOLDOWN CHECK ----------------------------------------------------------
	// Indicates whether an OPEN circuit is still within the no-probe cooldown period.
	isCoolingDown(): boolean {
		return this.state === 'OPEN' && Date.now() < this.nextProbeTs;
	}

	// OPEN STATE LOG THROTTLE -------------------------------------------------
	// Periodically logs that the circuit is still OPEN without spamming.
	logOpenState(now: number): void {
		if (now - this.lastOpenLogTs < this.slowLogIntervalMs) return;
		this.lastOpenLogTs = now;
		logger.alert(`Circuit ${this.name} still degraded`, {
			reason: this.openReason,
			retryInMs: Math.max(this.nextProbeTs - now, 0),
		});
	}

	// STATE SNAPSHOT ----------------------------------------------------------
	// Provides a minimal view for diagnostics endpoints and tests.
	getState(): CircuitBreakerState {
		return {
			name: this.name,
			state: this.state,
			reason: this.openReason,
			totalRequests: this.totalRequests,
			totalFailures: this.totalFailures,
			nextProbe: this.state === 'OPEN' ? new Date(this.nextProbeTs).toISOString() : null,
		};
	}
}

// FACTORY ---------------------------------------------------------------------
// Convenience wrapper to avoid exporting `new` usage across the codebase.
export function createCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
	return new CircuitBreaker(name, options);
}

export { CircuitBreaker };
