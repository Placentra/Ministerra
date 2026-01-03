import { getLogger, logContext } from './loggers';

const logger = getLogger('CircuitBreaker');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_SLOW_THRESHOLD_MS = 150;
const DEFAULT_SLOW_BURST = 5;
const DEFAULT_SLOW_WINDOW_MS = 10000;
const DEFAULT_SLOW_LOG_INTERVAL_MS = 2000;
const DEFAULT_COOLDOWN_MS = 30000;

// CIRCUIT BREAKER -------------------------------------------------------------

// CLASS DEFINITION ---
// Implements the Circuit Breaker pattern for fault tolerance and resilience.
// Tracks failures, slow queries, and manages state transitions (OPEN/CLOSED/HALF-OPEN).
class CircuitBreaker {
	[key: string]: any;
	constructor(name, options: any = {}) {
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
		// NOTE: Init log removed - 20 workers x 3 breakers = 60 logs of noise
	}

	// EXECUTE ---------------------------------------------------------------
	// Steps: enforce OPEN/HALF_OPEN gating, apply timeout, account for failure/success, track slow operations, and optionally route through fallback.
	// Main entry point. Wraps execution with:
	// - OPEN/HALF_OPEN gating
	// - timeout enforcement
	// - failure/success accounting
	// - slow-operation detection and optional fallback routing
	async execute(fn, context = {}) {
		this.totalRequests++;

		const now = Date.now();
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

		const start = Date.now();
		try {
			// EXECUTION BLOCK ---
			const result = await this.runWithTimeout(fn);
			const duration = Date.now() - start;
			this.recordSuccess(duration, context);
			return result;
		} catch (error) {
			// FAILURE BLOCK ---
			const duration = Date.now() - start;
			if (this.shouldIgnoreError(error)) {
				throw error;
			}
			this.recordFailure(error, duration, context);

			if (this.fallback) {
				try {
					return await this.fallback(context);
				} catch (fallbackError) {
					logger.error(`Circuit ${this.name} fallback failed`, { error: fallbackError.message });
				}
			}

			throw error;
		}
	}

	// TIMEOUT WRAPPER --------------------------------------------------------
	// Enforces max execution duration. Rejects with a synthetic timeout error.
	// Steps: run fn() under a timer; clear timer on resolve/reject; reject with a synthetic timeout error when timer fires.
	runWithTimeout(fn) {
		if (!this.timeoutMs || this.timeoutMs <= 0) {
			return Promise.resolve().then(() => fn());
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${this.name} timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
			Promise.resolve()
				.then(() => fn())
				.then(
					result => {
						clearTimeout(timer);
						resolve(result);
					},
					error => {
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
	handleOpenState(context) {
		logger.alert(`Circuit ${this.name} is OPEN (reason=${this.openReason}), rejecting request`, {
			retryAt: new Date(this.nextProbeTs).toISOString(),
		});
		const error = new Error(`Circuit breaker ${this.name} is OPEN`);
		(error as any).code = 'CIRCUIT_OPEN';
		if (this.fallback) {
			return this.fallback(context);
		}
		throw error;
	}

	// SUCCESS ACCOUNTING ------------------------------------------------------
	// Resets failure counters and may close the circuit when a HALF_OPEN probe succeeds.
	// Steps: reset consecutive failures, track latency, and if this was a HALF_OPEN probe, close and clear probe-in-flight flag.
	recordSuccess(duration, context) {
		this.consecutiveFailures = 0;
		this.trackLatency(duration, context);

		if (this.state === 'HALF_OPEN') {
			// RECOVERY LOG -------------------------------------------------------
			// Only log on recovery to avoid a high-frequency success log spam.
			let msg = `Circuit ${this.name} recovered (${duration}ms)`;
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
	recordFailure(error, duration, context) {
		this.totalFailures++;
		this.consecutiveFailures++;

		this.logWithLevel(this.failureLogLevel, `Circuit ${this.name} failure`, {
			state: this.state,
			failures: this.consecutiveFailures,
			error: error?.message,
		});

		this.trackLatency(duration, context, true);

		const shouldOpen = this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold || (error && (error as any).code === 'ER_LOCK_WAIT_TIMEOUT');

		if (shouldOpen) {
			this.open('errors');
		}
	}

	// ERROR & LOGGING HELPERS ------------------------------------------------

	// IGNORE ERROR ------------------------------------------------------------
	// Some errors (e.g., Redis BUSYGROUP) are expected and should not contribute to breaker state.
	// Steps: apply a narrow allowlist of ignorable errors; everything else contributes to breaker state.
	shouldIgnoreError(error) {
		if (this.name !== 'Redis') return false;
		const msg = String(error?.message || error || '');
		if (!msg) return false;
		return msg.includes('BUSYGROUP') || msg.includes('Consumer Group name already exists');
	}

	// LEVEL-AWARE LOGGING -----------------------------------------------------
	// Routes through the configured logger method (warn/info/error/slow), with a silent option.
	logWithLevel(level, message, meta) {
		if (level === 'silent') return;
		const logFn = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.alert.bind(logger);
		logFn(message, meta);
	}

	// LATENCY TRACKING --------------------------------------------------------
	// Records slow events, logs slow operations at a controlled interval, and opens the circuit
	// if slow events burst above threshold.
	// Steps: push timestamps for slow ops, trim to window, emit slow log at interval, and OPEN when burst threshold is exceeded.
	trackLatency(duration, context, failed = false) {
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
	logSlowQuery(duration, context, failed) {
		const now = Date.now();
		if (now - this.lastSlowLogTs < this.slowLogIntervalMs) {
			return;
		}

		this.lastSlowLogTs = now;
		const sqlPreview = context.sql ? String(context.sql).replace(/\s+/g, ' ').slice(0, 500) : undefined;

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
	trimSlowEvents() {
		const cutoff = Date.now() - this.slowWindowMs;
		while (this.recentSlowEvents.length && this.recentSlowEvents[0] < cutoff) {
			this.recentSlowEvents.shift();
		}
	}

	// STATE MANAGEMENT -------------------------------------------------------

	// OPEN CIRCUIT ------------------------------------------------------------
	// Moves the circuit to OPEN and starts cooldown before the next HALF_OPEN probe.
	// Steps: mark OPEN with reason, compute nextProbeTs, reset open log throttle, emit a single degraded alert.
	open(reason) {
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
	close() {
		this.state = 'CLOSED';
		this.openReason = null;
		this.consecutiveFailures = 0;
		this.recentSlowEvents = [];
		logger.info(`Circuit ${this.name} recovered`);
	}

	// COOLDOWN CHECK ----------------------------------------------------------
	// Indicates whether an OPEN circuit is still within the no-probe cooldown period.
	isCoolingDown() {
		return this.state === 'OPEN' && Date.now() < this.nextProbeTs;
	}

	// OPEN STATE LOG THROTTLE -------------------------------------------------
	// Periodically logs that the circuit is still OPEN without spamming.
	logOpenState(now) {
		if (now - this.lastOpenLogTs < this.slowLogIntervalMs) return;
		this.lastOpenLogTs = now;
		logger.alert(`Circuit ${this.name} still degraded`, {
			reason: this.openReason,
			retryInMs: Math.max(this.nextProbeTs - now, 0),
		});
	}

	// STATE SNAPSHOT ----------------------------------------------------------
	// Provides a minimal view for diagnostics endpoints and tests.
	getState() {
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
export function createCircuitBreaker(name, options) {
	return new CircuitBreaker(name, options);
}

export { CircuitBreaker };
