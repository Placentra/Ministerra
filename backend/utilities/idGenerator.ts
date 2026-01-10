// ID GENERATOR ==================================================================
// Snowflake-based ID generation for distributed scaling without coordination.
// All primary keys use 64-bit Snowflake IDs stored as BIGINT UNSIGNED.
//
// Layout (64 bits):
// - 1 bit: sign (always 0, positive - safe for signed BIGINT)
// - 41 bits: timestamp (ms since custom epoch) → ~69 years range
// - 10 bits: worker ID (0-1023) → 1024 nodes max
// - 12 bits: sequence (0-4095) → 4096 IDs/ms per worker
//
// Capacity: 4,096,000 IDs/second per worker, ~4 billion/second cluster-wide
// Range: 2024-01-01 to ~2093 (custom epoch extends usable range)
//
// PRODUCTION REQUIREMENTS:
// - WORKER_ID env var MUST be set (0-1023) in production
// - Each node/container MUST have a unique WORKER_ID
// - Use orchestrator (K8s StatefulSet ordinal, Swarm slot) or Redis lease
// =============================================================================

// CONFIGURATION ---
const CUSTOM_EPOCH = 1704067200000n; // 2024-01-01T00:00:00Z
const WORKER_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n; // 1023
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n; // 4095
const WORKER_ID_SHIFT = SEQUENCE_BITS; // 12
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS; // 22

// WORKER STATE ---
let workerID: bigint = 0n;
let lastTimestamp: bigint = -1n;
let sequence: bigint = 0n;
let initialized = false;

// ERROR CLASSES ---
export class SequenceOverflowError extends Error {
	constructor() {
		super('Sequence overflow: 4096 IDs generated in 1ms, retry after 1ms');
		this.name = 'SequenceOverflowError';
	}
}

export class ClockDriftError extends Error {
	constructor(drift: bigint) {
		super(`Clock moved backwards by ${drift}ms - rejecting ID generation to prevent collision`);
		this.name = 'ClockDriftError';
	}
}

export class WorkerIDError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerIDError';
	}
}

// INITIALIZE WORKER ID --------------------------------------------------------
// Steps: WORKER_ID env var is MANDATORY in production. Dev mode allows fallback for local testing only.
function initWorkerID(): void {
	if (initialized) return;

	const envWorkerID = process.env.WORKER_ID;
	const isProduction = process.env.NODE_ENV === 'production';

	// MANDATORY IN PRODUCTION ---
	if (envWorkerID !== undefined && envWorkerID !== '') {
		const parsed = parseInt(envWorkerID, 10);
		if (isNaN(parsed) || parsed < 0 || parsed > Number(MAX_WORKER_ID)) {
			throw new WorkerIDError(`WORKER_ID must be 0-${MAX_WORKER_ID}, got: ${envWorkerID}`);
		}
		workerID = BigInt(parsed);
		initialized = true;
		return;
	}

	// PRODUCTION WITHOUT WORKER_ID = FATAL ---
	if (isProduction) {
		throw new WorkerIDError('WORKER_ID env var is REQUIRED in production. Set unique value 0-1023 per node.');
	}

	// DEV MODE FALLBACK ---
	// Steps: use PID for local development only. NOT safe for multi-node.
	workerID = BigInt(process.pid % 1024);
	initialized = true;
	console.warn(`[idGenerator] DEV MODE: using PID-based workerID=${workerID}. Set WORKER_ID env var for production.`);
}

// SET WORKER ID ---------------------------------------------------------------
// Steps: explicit override for orchestrated deployments (K8s, Docker Swarm).
export function setWorkerID(id: number): void {
	if (id < 0 || id > Number(MAX_WORKER_ID)) throw new WorkerIDError(`workerID must be 0-${MAX_WORKER_ID}`);
	workerID = BigInt(id);
	initialized = true;
}

// GET WORKER ID ---------------------------------------------------------------
export function getWorkerID(): number {
	if (!initialized) initWorkerID();
	return Number(workerID);
}

// GENERATE SNOWFLAKE ID -------------------------------------------------------
// Steps: ensure worker initialized, get timestamp, handle sequence/overflow, assemble bits.
// THROWS on clock drift or sequence overflow - caller must handle retry.
export function generateID(): bigint {
	if (!initialized) initWorkerID();

	const timestamp = BigInt(Date.now()) - CUSTOM_EPOCH;

	// CLOCK DRIFT ---
	// Steps: if clock moved backwards (NTP sync, VM migration), THROW immediately.
	// Spinning blocks the event loop; throwing lets caller decide retry strategy.
	if (timestamp < lastTimestamp) {
		throw new ClockDriftError(lastTimestamp - timestamp);
	}

	// SEQUENCE ---
	// Steps: if same ms, increment sequence; if sequence overflows (>4095), THROW.
	// Caller should wait ~1ms and retry. This prevents event loop blocking.
	if (timestamp === lastTimestamp) {
		sequence = (sequence + 1n) & MAX_SEQUENCE;
		if (sequence === 0n) {
			throw new SequenceOverflowError();
		}
	} else {
		sequence = 0n;
	}

	lastTimestamp = timestamp;

	// ASSEMBLE ---
	return (timestamp << TIMESTAMP_SHIFT) | (workerID << WORKER_ID_SHIFT) | sequence;
}

// GENERATE ID AS STRING -------------------------------------------------------
// Steps: return string representation for MySQL bigint (avoids JS precision loss beyond 2^53).
export function generateIDString(): string {
	return generateID().toString();
}

// GENERATE ID WITH RETRY ------------------------------------------------------
// Steps: handles SequenceOverflowError automatically by waiting 1ms. Use for non-critical paths.
export async function generateIDWithRetry(maxRetries: number = 3): Promise<bigint> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return generateID();
		} catch (err) {
			if (err instanceof SequenceOverflowError && attempt < maxRetries - 1) {
				await new Promise(resolve => setTimeout(resolve, 1));
				continue;
			}
			throw err;
		}
	}
	throw new SequenceOverflowError();
}

// GENERATE ID STRING WITH RETRY -----------------------------------------------
export async function generateIDStringWithRetry(maxRetries: number = 3): Promise<string> {
	return (await generateIDWithRetry(maxRetries)).toString();
}

// GENERATE BATCH --------------------------------------------------------------
// Steps: generate multiple IDs; throws if sequence exhausted mid-batch.
export function generateIDBatch(count: number): bigint[] {
	const ids: bigint[] = new Array(count);
	for (let i = 0; i < count; i++) ids[i] = generateID();
	return ids;
}

// GENERATE BATCH AS STRINGS ---------------------------------------------------
export function generateIDBatchStrings(count: number): string[] {
	const ids: string[] = new Array(count);
	for (let i = 0; i < count; i++) ids[i] = generateID().toString();
	return ids;
}

// EXTRACT TIMESTAMP -----------------------------------------------------------
// Steps: extract creation timestamp from ID for debugging, analytics, ordering verification.
export function extractTimestamp(id: bigint | string): Date {
	const snowflake = typeof id === 'string' ? BigInt(id) : id;
	const timestamp = (snowflake >> TIMESTAMP_SHIFT) + CUSTOM_EPOCH;
	return new Date(Number(timestamp));
}

// EXTRACT WORKER ID -----------------------------------------------------------
export function extractWorkerID(id: bigint | string): number {
	const snowflake = typeof id === 'string' ? BigInt(id) : id;
	return Number((snowflake >> WORKER_ID_SHIFT) & MAX_WORKER_ID);
}

// EXTRACT SEQUENCE ------------------------------------------------------------
export function extractSequence(id: bigint | string): number {
	const snowflake = typeof id === 'string' ? BigInt(id) : id;
	return Number(snowflake & MAX_SEQUENCE);
}

// PARSE ID (FULL BREAKDOWN) ---------------------------------------------------
export function parseID(id: bigint | string): { timestamp: Date; workerID: number; sequence: number } {
	return {
		timestamp: extractTimestamp(id),
		workerID: extractWorkerID(id),
		sequence: extractSequence(id),
	};
}

// COMPARE IDS BY TIME ---------------------------------------------------------
// Steps: compare two IDs chronologically (useful for cursor-based pagination).
export function compareIDs(a: bigint | string, b: bigint | string): number {
	const idA = typeof a === 'string' ? BigInt(a) : a;
	const idB = typeof b === 'string' ? BigInt(b) : b;
	if (idA < idB) return -1;
	if (idA > idB) return 1;
	return 0;
}

// TYPE DEFINITIONS ---
/* eslint-disable no-unused-vars */
export interface IDGeneratorAPI {
	generate(): bigint;
	generateString(): string;
	generateWithRetry(maxRetries?: number): Promise<bigint>;
	generateStringWithRetry(maxRetries?: number): Promise<string>;
	generateBatch(count: number): bigint[];
	generateBatchStrings(count: number): string[];
	extractTimestamp(id: bigint | string): Date;
	extractWorkerID(id: bigint | string): number;
	extractSequence(id: bigint | string): number;
	parseID(id: bigint | string): { timestamp: Date; workerID: number; sequence: number };
	compareIDs(a: bigint | string, b: bigint | string): number;
	setWorkerID(id: number): void;
	getWorkerID(): number;
}
/* eslint-enable no-unused-vars */

// DEFAULT EXPORT ---
const idGen: IDGeneratorAPI = {
	generate: generateID,
	generateString: generateIDString,
	generateWithRetry: generateIDWithRetry,
	generateStringWithRetry: generateIDStringWithRetry,
	generateBatch: generateIDBatch,
	generateBatchStrings: generateIDBatchStrings,
	extractTimestamp,
	extractWorkerID,
	extractSequence,
	parseID,
	compareIDs,
	setWorkerID,
	getWorkerID,
};

export default idGen;
