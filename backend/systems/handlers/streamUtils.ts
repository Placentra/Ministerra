import { Streamer } from '../systems.ts';
import { getLogger } from './loggers.ts';

const logger = getLogger('StreamUtils');
const LOW_POWER_STREAMS = process.env.STREAM_LOW_POWER === '0';
const METRICS_ENABLED = !LOW_POWER_STREAMS && process.env.STREAM_METRICS !== '0';

// ENV NUM PARSER --------------------------------------------------------------
// Reads a numeric env var and enforces "positive number" semantics.
// This prevents accidental 0/NaN values from silently disabling limits.
// Steps: parse Number, validate finite + >0, otherwise return provided default.
function getEnvNum(name: string, def: number): number {
	// Parse env var as positive number with fallback ---------------------------
	const v: number = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : def;
}

// METRICS INCREMENT -----------------------------------------------------------
// Best-effort metrics updates stored in Redis hashes, disabled in low-power mode.
// Steps: hincrby fields in one pipeline, swallow errors (metrics must not break the stream consumer).
async function incMetrics(redis: any, streamName: string, increments: Record<string, number> = {}): Promise<void> {
	if (!METRICS_ENABLED) return;
	try {
		const key: string = `metrics:streams:${streamName}`;
		const pipe: any = redis.pipeline();
		for (const [field, delta] of Object.entries(increments)) {
			if (!Number.isFinite(delta) || delta === 0) continue;
			pipe.hincrby(key, field, delta);
		}
		await pipe.exec();
	} catch (e: any) {
		logger.debug('streamUtils.incMetrics_failed', { error: e?.message });
	}
}

interface DrainStreamOptions {
	redis: any;
	streamName: string;
	group: string;
	consumer: string;
	logPrefix?: string;
	readCount?: number;
	maxBatches?: number;
	maxLoopMs?: number;
	claimIdleMs?: number;
	claimCount?: number;
}

interface DrainStreamResult {
	items: any[];
	ack: () => Promise<void>;
	warn: () => Promise<void>;
}

// DRAIN STREAM ----------------------------------------------------------------
// Higher-level stream consumer built on Streamer():
// - loops multiple batches within a time budget
// - optionally adapts readCount based on pending backlog
// - returns { items, ack, warn } so callers can acknowledge and emit capacity warnings
// Steps: repeatedly read batches within a time budget, optionally increase readCount under backlog, return ack/warn helpers so caller controls finalization timing.
export async function drainStream({
	redis,
	streamName,
	group,
	consumer,
	logPrefix = '[stream]',
	readCount = getEnvNum('STREAM_READ_COUNT', LOW_POWER_STREAMS ? 250 : 1000),
	maxBatches = LOW_POWER_STREAMS ? 1 : getEnvNum('STREAM_MAX_BATCHES', 5),
	maxLoopMs = LOW_POWER_STREAMS ? 150 : getEnvNum('STREAM_MAX_LOOP_MS', 500),
	claimIdleMs = getEnvNum('STREAM_CLAIM_IDLE_MS', 0),
	claimCount = getEnvNum('STREAM_CLAIM_COUNT', LOW_POWER_STREAMS ? 100 : 500),
}: DrainStreamOptions): Promise<DrainStreamResult> {
	const items: any[] = [];
	const ids: string[] = [];
	const start: number = Date.now();
	for (let i = 0; i < maxBatches && Date.now() - start < maxLoopMs; i++) {
		const res: any = await Streamer({
			redis,
			streamName,
			logPrefix,
			group,
			consumer,
			count: readCount,
			blockMs: 0,
			claimIdleMs,
			claimCount,
		});
		if (!res.processed) break;
		items.push(...res.items);
		if (Array.isArray(res.ids)) ids.push(...res.ids);
		if (res.processed < readCount) break;

		// Adaptive backpressure: increase readCount within ceiling under lag
		// Steps: when pending backlog exceeds current readCount, increase readCount gradually up to ceiling so consumers can catch up without spiking CPU instantly.
		if (!LOW_POWER_STREAMS) {
			try {
				const pend: any = await redis.xpending(streamName, group).catch(() => null);
				const pendCnt: number = Array.isArray(pend) ? Number(pend[0] || 0) : 0;
				const ceil: number = getEnvNum('STREAM_READ_COUNT_MAX', Math.max(readCount, 5000));
				const step: number = getEnvNum('STREAM_READ_COUNT_STEP', 500);
				if (pendCnt > readCount && readCount < ceil) readCount = Math.min(ceil, readCount + step);
			} catch (e: any) {
				logger.debug('streamUtils.backpressure_calc_failed', { error: e?.message });
			}
		}
	}

	// ACK WITH RETRY -----------------------------------------------------------
	// Acks collected IDs with a small retry loop; failure is logged but not thrown.
	// Steps: xack all IDs, retry a few times with small delay; log on final failure and continue.
	async function ackWithRetry(): Promise<void> {
		if (ids.length === 0) return;
		let attempts: number = 0;
		while (attempts < 3) {
			try {
				await redis.xack(streamName, group, ...ids);
				await incMetrics(redis, streamName, { acked: ids.length });
				return;
			} catch (error: any) {
				attempts++;
				if (attempts >= 3) {
					logger.error('streamUtils.ack_retry_failed', { error, streamName, logPrefix });
					return;
				}
				await new Promise(r => setTimeout(r, 150 * attempts));
			}
		}
	}

	// WARN IF NEAR CAP ---------------------------------------------------------
	// Emits warnings when stream length or pending backlog approaches configured limits.
	// Steps: check xlen and xpending, emit alerts when thresholds are crossed, and increment metrics for later diagnosis.
	async function warnIfNearCap(): Promise<void> {
		if (!METRICS_ENABLED) return;
		try {
			const STREAM_MAXLEN: number = Number(process.env.STREAM_MAXLEN) || 0;
			const STREAM_XLEN_WARN_RATIO: number = Number(process.env.STREAM_XLEN_WARN_RATIO) || 0.8;
			const STREAM_XPENDING_WARN: number = Number(process.env.STREAM_XPENDING_WARN) || 0;
			const [len, pending]: [number, any] = await Promise.all([redis.xlen(streamName).catch(() => 0), redis.xpending(streamName, group).catch(() => null)]);
			const pendCnt: number = Array.isArray(pending) && typeof pending[0] === 'number' ? pending[0] : 0;
			if (STREAM_XPENDING_WARN && pendCnt >= STREAM_XPENDING_WARN) {
				logger.alert('streamUtils.pending_backlog_threshold', { streamName, pending: pendCnt, logPrefix });
				await incMetrics(redis, streamName, { xpending_warns: 1 });
			}
			if (STREAM_MAXLEN && len / STREAM_MAXLEN >= STREAM_XLEN_WARN_RATIO) {
				logger.alert('streamUtils.stream_near_maxlen', {
					streamName,
					length: len,
					ratio: Number((len / STREAM_MAXLEN).toFixed(2)),
					logPrefix,
				});
				await incMetrics(redis, streamName, { xlen_warns: 1 });
			}
		} catch (e: any) {
			logger.alert('streamUtils.alertIfNearCap_failed', { error: e?.message });
		}
	}

	if (items.length) await incMetrics(redis, streamName, { processed: items.length });

	return { items, ack: ackWithRetry, warn: warnIfNearCap };
}
