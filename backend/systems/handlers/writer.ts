import fs from 'fs';
import path from 'path';
import { Querer } from './querer';
import { getLogger } from './loggers';

// CONSTANTS -------------------------------------------------------------------
// Steps: pull operational limits from env (batch size, retry dir, retry caps, DLQ stream), then reuse them everywhere so failure behavior is predictable and tunable without code changes.
const MAX_BATCH_SIZE = Number(process.env.WRITER_MAX_BATCH_SIZE) || 5000;
const RETRY_DIR = path.resolve(process.env.WRITER_RETRY_DIR || './writeFailures');
const MAX_RETRY_FILES_PER_RUN = Number(process.env.WRITER_MAX_RETRY_FILES) || 100;
const MAX_RETRY_ATTEMPTS = Number(process.env.WRITER_MAX_RETRY_ATTEMPTS) || 6;
const DLQ_STREAM = process.env.DLQ_STREAM || 'sqlFailedDLQ';
const MAX_RETRY_BUFFER_ROWS = Number(process.env.WRITER_MAX_RETRY_BUFFER_ROWS) || 5000;
const MAX_FAILED_FILE_BYTES = Number(process.env.WRITER_MAX_FAILED_FILE_BYTES) || 5 * 1024 * 1024; // 5MB default cap
const IDENTIFIER_REGEX = /^[A-Za-z0-9_]+$/;
const RETRY_FILE_LOCK_SUFFIX = `.lock.${process.pid}`;
const STALE_LOCK_AGE_MS = 30 * 60 * 1000; // 30 minutes
const NON_RETRIABLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const createdTempTablesByConn = new WeakMap();
// LOGGER ----------------------------------------------------------------------
// Steps: wrap logger type with a warn method because callsites use warn-level semantics, but the base logger typing exposes a narrower interface.
const writerLogger = getLogger('Writer');
const DEBUG_WRITER = process.env.DEBUG_WRITER === '1';

// SAFE IDENTIFIER --------------------------------------------------------------
// Steps: validate dynamic SQL identifiers (table/column names) with a strict whitelist because identifiers cannot be parameterized; throw with context so bad task config is debuggable.
const ensureSafeIdentifier = (value, context) => {
	if (typeof value !== 'string' || !IDENTIFIER_REGEX.test(value)) {
		throw new Error(`[Writer] Invalid ${context} identifier "${value}"`);
	}
	return value;
};

// SAFE IDENTIFIER LIST ---------------------------------------------------------
// Steps: validate each identifier in a list so later SQL interpolation stays safe while error messages still point to the broken column group.
const ensureSafeIdentifierList = (list = [], context) => list.map(identifier => ensureSafeIdentifier(identifier, context));

// ROW NORMALIZATION ------------------------------------------------------------
// Steps: accept both [a,b,c] and [[a,b,c],[...]] payload shapes, then normalize to a 2D array so batching and placeholder construction can stay uniform.
const normalizeRows = rows => {
	if (!Array.isArray(rows) || !rows.length) return [];
	return Array.isArray(rows[0]) ? rows : [rows];
};

// SAFE UNLINK ------------------------------------------------------------------
// Steps: best-effort delete; treat ENOENT as already-deleted, but bubble everything else so callers can decide whether to fail the run or continue.
const safeUnlink = async filePath => {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (err?.code !== 'ENOENT') throw err;
	}
};

// TODO probably get the col defs from the database itself
// TODO implement BULL Q across the app, probably.

// WRITER ----------------------------------------------------------------------
// Steps: replay buffered retriable failures first (so backlog shrinks), then process the current flush in bounded batches; on retriable failure persist to disk (or DLQ after max attempts) and never throw past this boundary so worker threads stay alive.
// Rationale: this is the durability boundary for stream-driven work; “buffer and continue” beats crashing workers and losing throughput.
export async function Writer(props) {
	const { userTableChanges = new Map(), mode, tasksConfig, redis, con } = props || {};

	// INPUT VALIDATION ----------------------------------------------------------
	// Steps: validate the minimal contract early so failures are loud and local (bad caller), not silent corruption inside SQL retry logic.
	if (!mode || typeof mode !== 'string') throw new Error('[Writer] mode is required');
	if (!Array.isArray(tasksConfig)) throw new Error('[Writer] tasksConfig must be an array');
	if (!con?.execute || typeof con.execute !== 'function') throw new Error('[Writer] con must expose an execute method');
	if (!redis || typeof redis.pipeline !== 'function' || typeof redis.xadd !== 'function') throw new Error('[Writer] redis client must expose pipeline and xadd');

	const safeUserTableChanges = userTableChanges instanceof Map ? userTableChanges : new Map();

	// WRITE FAILED FILE ---------------------------------------------------------
	// Steps: serialize payload to JSON, enforce size cap (disk safety), then write a timestamped file that encodes mode/name/retriable/attempts so replay can rehydrate the right operation template.
	async function writeFailedFile(key, data, isRetriable = false, attempts = 0) {
		try {
			const filePath = path.join(RETRY_DIR, `${mode}_${key}_${isRetriable ? 'retriable' : 'non-retriable'}_${attempts}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
			await fs.promises.mkdir(RETRY_DIR, { recursive: true });
			const payload = JSON.stringify(data);
			const payloadSize = Buffer.byteLength(payload);
			if (payloadSize > MAX_FAILED_FILE_BYTES) {
				throw new Error(`[Writer] Failed payload for ${key} exceeds ${MAX_FAILED_FILE_BYTES} bytes (was ${payloadSize})`);
			}
			await fs.promises.writeFile(filePath, payload);
			writerLogger.info(`Wrote failed ${isRetriable ? 'retriable' : 'non-retriable'} data to ${filePath}`);
		} catch (error) {
			writerLogger.error(`Error writing failed file for ${key}`, { error: error?.message });
			throw error;
		}
	}

	// LOAD FAILED FILES ---------------------------------------------------------
	// Steps: clean stale locks (crash recovery), lock files via rename (single-consumer), parse JSON safely (quarantine corruption), map file->taskConfig template by name, then merge rows into bounded retry ops so one run can’t explode memory.
	async function loadFailedFiles(mode, tasksConfig) {
		const retryOperations = [];
		const failedFiles = [];

		// ADD RETRY OPERATION ----------------------------------------------------
		// Steps: normalize row shape, then pack rows into operations capped by MAX_RETRY_BUFFER_ROWS so replays are incremental and predictable.
		const addRetryOperation = (operationTemplate, items, attempts) => {
			const normalizedItems = normalizeRows(items);
			if (!normalizedItems.length) return;
			const { arrs: _ignoredArrs, ...templateMeta } = operationTemplate;

			// CREATE OPERATION ----------------------------------------------------
			// Steps: clone template metadata, attach empty arrs buffer + attempts, then return it so the caller can fill it to capacity.
			const createOperation = () => {
				const op = { ...templateMeta, arrs: [], attempts };
				retryOperations.push(op);
				return op;
			};

			let targetOperation = retryOperations.find(op => op.name === templateMeta.name && op.attempts === attempts && op.arrs.length < MAX_RETRY_BUFFER_ROWS) || createOperation();
			let remaining = [...normalizedItems];

			while (remaining.length) {
				const capacity = MAX_RETRY_BUFFER_ROWS - targetOperation.arrs.length;
				if (capacity <= 0) {
					targetOperation = createOperation();
					continue;
				}
				targetOperation.arrs.push(...remaining.splice(0, capacity));
			}
		};

		try {
			await fs.promises.mkdir(RETRY_DIR, { recursive: true });
			const files = await fs.promises.readdir(RETRY_DIR);

			// Clean up stale lock files from crashed processes
			const now = Date.now();
			for (const file of files) {
				if (file.includes('.lock.')) {
					const lockPath = path.join(RETRY_DIR, file);
					try {
						const stat = await fs.promises.stat(lockPath);
						if (now - stat.mtimeMs > STALE_LOCK_AGE_MS) {
							// Remove stale lock by renaming back to original (without .lock.pid suffix)
							const originalName = file.replace(/\.lock\.\d+$/, '');
							const originalPath = path.join(RETRY_DIR, originalName);
							try {
								await fs.promises.rename(lockPath, originalPath);
								writerLogger.alert(`Recovered stale lock file: ${file} -> ${originalName}`);
							} catch (renameError) {
								// If original exists, just delete the stale lock
								await safeUnlink(lockPath);
								writerLogger.alert(`Deleted stale lock file (original exists): ${file}`);
							}
						}
					} catch (statError) {
						if (statError?.code !== 'ENOENT') writerLogger.error(`Error checking stale lock: ${file}`, { error: statError?.message });
					}
				}
			}

			// NON-RETRIABLE CLEANUP ---
			// Steps: delete non-retriable forensic files older than 30 days
			for (const file of files) {
				if (file.includes('_non-retriable_') && file.endsWith('.json')) {
					const filePath = path.join(RETRY_DIR, file);
					try {
						const stat = await fs.promises.stat(filePath);
						if (now - stat.mtimeMs > NON_RETRIABLE_MAX_AGE_MS) {
							await safeUnlink(filePath);
							writerLogger.info(`Deleted stale non-retriable file: ${file}`);
						}
					} catch (statError) {
						if (statError?.code !== 'ENOENT') writerLogger.error(`Error checking non-retriable file: ${file}`, { error: statError?.message });
					}
				}
			}

			// Re-read files after cleanup
			const freshFiles = await fs.promises.readdir(RETRY_DIR);
			const modeFiles = freshFiles.filter(file => file.startsWith(`${mode}_`) && file.includes('_retriable_') && file.endsWith('.json')).slice(0, MAX_RETRY_FILES_PER_RUN);

			for (const file of modeFiles) {
				// LOCK VIA RENAME ---------------------------------------------------
				// Steps: rename to a pid-suffixed lock name so two workers don’t process the same payload; on failure, skip or record the file depending on error code.
				const originalPath = path.join(RETRY_DIR, file);
				const lockPath = `${originalPath}${RETRY_FILE_LOCK_SUFFIX}`;
				try {
					await fs.promises.rename(originalPath, lockPath);
				} catch (renameError) {
					if (renameError?.code === 'ENOENT') continue;
					writerLogger.error(`Error locking retry file "${file}"`, { error: renameError?.message });
					failedFiles.push(file);
					continue;
				}

				try {
					// PARSE + MAP TO TEMPLATE -----------------------------------------
					// Steps: parse JSON, extract {name,attempts} from filename, then find the matching task template so replay keeps identical SQL semantics.
					const fileContent = await fs.promises.readFile(lockPath, 'utf-8');
					let failedData;
					try {
						failedData = JSON.parse(fileContent);
					} catch (parseError) {
						// Corrupted JSON - move to a quarantine file and continue processing other files
						const quarantinePath = `${lockPath}.corrupted`;
						writerLogger.error(`Corrupted JSON in retry file "${file}", quarantining`, { error: parseError?.message });
						try {
							await fs.promises.rename(lockPath, quarantinePath);
						} catch (renameError) {
							await safeUnlink(lockPath); // If can't quarantine, just delete
						}
						continue; // Don't block other files from processing
					}
					// GREEDY MATCH ---
					// Steps: use greedy capture so names containing `_retriable_` are fully matched up to the last occurrence.
					const nameMatch = file.match(new RegExp(`^${mode}_(.+)_retriable_(\\d+)_`));
					if (!nameMatch) {
						await safeUnlink(lockPath);
						continue;
					}
					const [name, attemptsRaw] = [nameMatch[1], Number(nameMatch[2] || '0')];
					const operationTemplate = tasksConfig.find(({ name: key }) => key === name);
					if (operationTemplate) addRetryOperation(operationTemplate, failedData, attemptsRaw);
					else writerLogger.alert(`No operation found for name: ${name} in mode: ${mode}`);

					await safeUnlink(lockPath);
				} catch (error) {
					writerLogger.error(`Error processing retry file "${file}"`, { error: error?.message });
					failedFiles.push(file);
					try {
						await fs.promises.rename(lockPath, originalPath);
					} catch (revertError) {
						if (revertError?.code !== 'ENOENT') writerLogger.error(`Error reverting retry file "${file}"`, { error: revertError?.message });
					}
				}
			}
		} catch (error) {
			writerLogger.error('Error reading retry directory', { error: error?.message });
			throw error;
		}

		if (failedFiles.length) {
			throw new Error(`[Writer] Failed to process ${failedFiles.length} retry files`);
		}

		return retryOperations;
	}

	// CREATE BATCHES -------------------------------------------------------------
	// Steps: split an array into MAX_BATCH_SIZE chunks so placeholder strings and packet sizes remain bounded.
	const createBatches = (arr, size = MAX_BATCH_SIZE) => Array.from({ length: Math.ceil(arr.length / size) }, (_, index) => arr.slice(index * size, index * size + size));

	// EXECUTE TASK ---------------------------------------------------------------
	// Steps: normalize rows, validate identifiers (table/cols/where) to keep interpolation safe, prepare temp tables for non-insert ops, then execute batched inserts/updates and translate Querer failures into a {isRetriable,arrs,name,attempts} shape for retry buffering.
	const executeTask = async (task, retryingFailed) => {
		let { arrs, table, cols = [], colsDef = [], name = table, onDupli = [], is, where = [], attempts = 0 } = task || {};

		if (!table || typeof table !== 'string') throw new Error('[Writer] Task table is required');
		if (!is || typeof is !== 'string') throw new Error(`[Writer] Task "${table}" is missing an operation type`);

		let normalizedArrs = normalizeRows(arrs);
		if (!normalizedArrs.length) {
			writerLogger.alert(`Skipping empty task for ${table}`);
			return;
		}
		if (Array.isArray(normalizedArrs[0][0])) normalizedArrs = normalizedArrs.flat();

		const safeTable = ensureSafeIdentifier(table, 'table');
		const safeName = ensureSafeIdentifier(name || table, 'temp table');
		const safeCols = ensureSafeIdentifierList(Array.isArray(cols) ? cols : [], `columns for ${safeTable}`);
		const safeWhere = ensureSafeIdentifierList(Array.isArray(where) ? where : [], `where columns for ${safeTable}`);
		const safeOnDupli = ensureSafeIdentifierList(Array.isArray(onDupli) ? onDupli : [], `ON DUPLICATE columns for ${safeTable}`);
		const columnDefinitions = Array.isArray(colsDef) ? colsDef : [];

		if (safeOnDupli.length && !is.includes('insert')) {
			throw new Error(`[Writer] ON DUPLICATE columns are only valid for insert operations (${safeTable})`);
		}
		if (safeOnDupli.length) {
			for (const col of safeOnDupli) {
				if (!safeCols.includes(col)) throw new Error(`[Writer] ON DUPLICATE column "${col}" must exist in the insert column list for "${safeTable}"`);
			}
		}

		const requiredCols = is.includes('insert') ? safeCols : safeWhere;
		if (!requiredCols.length) {
			throw new Error(`[Writer] Task "${safeTable}" is missing required ${is.includes('insert') ? 'column' : 'where'} definitions`);
		}
		if (!is.includes('insert') && is !== 'delete' && !safeCols.length) {
			throw new Error(`[Writer] Task "${safeTable}" requires column definitions for operation "${is}"`);
		}

		// COLUMN DEF ------------------------------------------------------------
		// Steps: map column->definition by position; default to VARCHAR(255) so temp tables can still be created even when caller didn’t supply types (TODO: derive from schema).
		const getColumnDefinition = column => {
			const defIndex = safeCols.indexOf(column);
			const definition = columnDefinitions[defIndex];
			return typeof definition === 'string' && definition.trim().length ? definition : 'VARCHAR(255)';
		};

		// TEMP TABLE DEF --------------------------------------------------------
		// Steps: include both SET cols and WHERE cols so joins can match and updates can write; de-dupe to keep DDL stable.
		const buildTempTableDefinition = () => {
			const columnsForTemp = [...new Set([...safeCols, ...safeWhere])];
			return columnsForTemp.map(col => `${col} ${getColumnDefinition(col)}`).join(', ');
		};

		// ROW SHAPE VALIDATION --------------------------------------------------
		// Steps: compute expected column order (sumUp needs where+cols), then require every row to match exactly so placeholder construction and binding don’t desync.
		const validateRowShape = rows => {
			const allCols = is === 'sumUp' ? [...safeWhere, ...safeCols] : [...safeCols, ...safeWhere];
			for (const row of rows) {
				if (!Array.isArray(row)) throw new Error(`[Writer] Row payload for ${safeTable} must be an array`);
				if (row.length !== allCols.length) {
					throw new Error(`[Writer] Row for ${safeTable} expected ${allCols.length} values, received ${row.length}`);
				}
			}
			return allCols;
		};

		const allCols = validateRowShape(normalizedArrs);

		try {
			const connSet = createdTempTablesByConn.get(con) || new Set();
			const isInsertOperation = is.includes('insert');

			// TEMP TABLE PREP -----------------------------------------------------
			// Steps: for non-insert ops, create temp table once per connection, then truncate before each use so UPDATE JOIN sees only current batch keys.
			if (!isInsertOperation && !connSet.has(safeName)) {
				try {
					await con.execute(`CREATE TEMPORARY TABLE IF NOT EXISTS temp_${safeName} (${buildTempTableDefinition()})`);
					connSet.add(safeName);
					createdTempTablesByConn.set(con, connSet);
				} catch (error) {
					writerLogger.error(`Error creating temporary table for ${safeTable}`, { error: error?.message });
					throw error;
				}
			} else if (!isInsertOperation) {
				// TABLE ALREADY TRACKED ---
				// Steps: skip redundant CREATE since connSet guarantees existence; truncate only.
				try {
					await con.execute(`TRUNCATE TABLE temp_${safeName}`);
				} catch (error) {
					writerLogger.error(`Error truncating temporary table for ${safeName}`, { error: error?.message });
					throw error;
				}
			}

			const batchedArrs = createBatches(normalizedArrs);
			const queries = [];

			for (const batch of batchedArrs) {
				const PHs = batch.map(() => `(${Array(allCols.length).fill('?').join(',')})`).join(',');

				if (isInsertOperation) {
					// INSERT PATH ----------------------------------------------------
					// Steps: build INSERT/INSERT IGNORE (+ optional ON DUPLICATE) so writes happen directly without temp-table overhead.
					const onDupliClause = safeOnDupli.length ? `ON DUPLICATE KEY UPDATE ${safeOnDupli.map(col => `${col}=VALUES(${col})`).join(',')}` : '';
					const insertPrefix = is === 'insertIgnore' ? 'INSERT IGNORE' : 'INSERT';
					const query = `${insertPrefix} INTO ${safeTable} (${allCols.join(',')}) VALUES ${PHs} ${onDupliClause}`.trim();
					queries.push({ name: safeName, query, data: batch.flat() });
				} else {
					// TEMP + UPDATE PATH ---------------------------------------------
					// Steps: load keys/values into temp table, then run one UPDATE JOIN per batch so MySQL can match on where columns and apply set semantics (sumUp/replace/delete-flag).
					const insertTempQuery = `INSERT INTO temp_${safeName} (${allCols.join(',')}) VALUES ${PHs}`;
					await con.execute(insertTempQuery, batch.flat());

					if (!safeWhere.length) throw new Error(`[Writer] Task "${safeTable}" requires where columns for non-insert operations`);
					const joinCond = safeWhere.map(col => `t.${col}=t2.${col}`).join(' AND ');
					let setClause = '';

					if (is === 'sumUp') setClause = safeCols.map(col => `t.${col}=t.${col}+t2.${col}`).join(', ');
					else if (is === 'replace') setClause = safeCols.map(col => `t.${col}=IFNULL(t2.${col}, t.${col})`).join(', ');
					else if (is === 'delete') setClause = 't.flag="del"';

					if (!setClause) throw new Error(`[Writer] Unsupported operation "${is}" for ${safeTable}`);

					const query = `UPDATE ${safeTable} t JOIN temp_${safeName} t2 ON ${joinCond} SET ${setClause}`;
					queries.push({ name: safeName, query });
				}
			}

			if (DEBUG_WRITER) writerLogger.info('executeTask queries', { mode, table: safeTable, queries });
			// BATCH EXECUTION ----------------------------------------------------
			// Steps: execute queries atomically in sequence; if Querer reports failure, convert it into a typed error so the outer loop can decide disk-retry vs DLQ.
			const failed = await Querer({ task: mode, con, queries, mode: 'atomic_seq' });
			const failedPayload = typeof failed === 'object' && failed !== null ? failed : {};
			if (failedPayload[mode] !== undefined) {
				const writerTaskError = new Error(`Writer failed for ${safeName || safeTable}`) as WriterTaskError;
				writerTaskError.isRetriable = Boolean(failedPayload[mode]);
				writerTaskError.arrs = normalizedArrs;
				writerTaskError.name = safeName || safeTable;
				writerTaskError.attempts = attempts;
				throw writerTaskError;
			}

			if (safeUserTableChanges.has(safeTable) && !retryingFailed) {
				// USER SUMMARY WATERMARKS ----------------------------------------
				// Steps: only update userSummary watermarks on non-retry runs so we don't advance "last changed" timestamps before the underlying SQL is actually durable.
				const lastChangesPipe = redis.pipeline();
				safeUserTableChanges.get(safeTable)?.forEach(userID => lastChangesPipe.hset(`userSummary:${userID}`, safeTable, Date.now()));
				safeUserTableChanges.delete(safeTable);
				await lastChangesPipe.exec();
			}

			return true;
		} catch (error) {
			if (DEBUG_WRITER) writerLogger.info('executeTask error payload', { error });
			if (typeof error === 'object' && error?.task) throw error;
			writerLogger.error(`Error executing query for ${safeTable}`, { error: error?.message, stack: error?.stack });
			throw error;
		}
	};

	// EXECUTE TASK LIST ----------------------------------------------------------
	// Steps: run tasks sequentially so we don’t explode concurrency on one connection, buffer retriable failures to disk (and DLQ after max attempts), and persist non-retriables for later inspection.
	async function executeTasks(tasks, retryingFailed) {
		const failedTasks = [];
		const persistFailedPayload = async (...args: Parameters<typeof writeFailedFile>) => {
			try {
				await writeFailedFile(...args);
			} catch (fileError) {
				writerLogger.error('[Writer] Unable to persist failed payload to disk', { error: fileError?.message });
			}
		};

		for (const task of tasks) {
			try {
				await executeTask(task, retryingFailed);
			} catch (error) {
				const writerTaskError = error as WriterTaskError;
				if (writerTaskError.isRetriable) {
					const nextAttempts = (writerTaskError.attempts || 0) + 1;
					if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
						try {
							await redis.xadd(DLQ_STREAM, '*', 'payload', JSON.stringify({ mode, name: writerTaskError.name, data: writerTaskError.arrs, attempts: nextAttempts }));
							writerLogger.error('[Writer] Moved to DLQ', { attempts: nextAttempts, task: writerTaskError.name });
						} catch (dlqError) {
							writerLogger.error('[Writer] Failed to enqueue payload into DLQ', { error: dlqError?.message });
						}
					} else {
						failedTasks.push({ ...(writerTaskError as any), attempts: nextAttempts });
						await persistFailedPayload(writerTaskError.name, writerTaskError.arrs, true, nextAttempts);
					}
				} else {
					writerLogger.error(`Non-retriable error for task ${task.name || task.table}`, { error: error?.message, stack: error?.stack });
					await persistFailedPayload(task.name || task.table, task.arrs, false);
				}
			}
		}
		return failedTasks;
	}

	// RUN ORCHESTRATION ----------------------------------------------------------
	// Steps: replay old retriable failures first, then process current flush; swallow top-level errors so the worker thread keeps running and retry artifacts remain available.
	try {
		const retryOperations = await loadFailedFiles(mode, tasksConfig);
		if (retryOperations.length) {
			if (DEBUG_WRITER) writerLogger.info('Processing retry tasks', { count: retryOperations.length, mode });
			await executeTasks(retryOperations, true);
		}

		// Process current flush
		if (DEBUG_WRITER) writerLogger.info('Processing current batch', { mode });
		const currentTasks = tasksConfig.filter(task => Array.isArray(task?.arrs) && task.arrs.length);
		const failedTasks = await executeTasks(currentTasks, false);

		if (failedTasks.length) writerLogger.alert('Tasks failed and will be retried', { count: failedTasks.length, mode });
	} catch (error) {
		writerLogger.error(`Critical error in Writer for mode ${mode}`, { error: error?.message, stack: error?.stack });
		// Don't throw here to prevent the entire worker from crashing
		// The error has been logged and failed tasks have been saved for retry
	}
}
