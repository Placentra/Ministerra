// STARTUP LOGGER =================================================================
// Unified, narrative-style startup logging that groups related events and removes noise.
// Provides readable, book-like startup sequence with timing and context.
// =============================================================================

import { getLogger } from '../systems/handlers/loggers.ts';

const logger = getLogger('Startup');
const startTime = Date.now();

// TIMING HELPER ----------------------------------------------------------------
function elapsed(): string {
	const ms = Date.now() - startTime;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// SECTION HEADERS --------------------------------------------------------------
export function logSection(title: string) {
	logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
	logger.info(`  ${title}`);
	logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

// STEP LOGGING -----------------------------------------------------------------
export function logStep(step: string, details?: string) {
	const detailStr = details ? ` (${details})` : '';
	logger.info(`  → ${step}${detailStr} [${elapsed()}]`);
}

// SUBSYSTEM READY --------------------------------------------------------------
export function logSubsystemReady(name: string, context?: string) {
	const ctx = context ? ` ${context}` : '';
	logger.info(`  ✓ ${name} ready${ctx} [${elapsed()}]`);
}

// COMPLETION BANNER -------------------------------------------------------------
export function logCompletion(totalTime: number) {
	const timeStr = totalTime < 1000 ? `${totalTime}ms` : `${(totalTime / 1000).toFixed(1)}s`;
	logger.info(`\n══════════════════════════════════════════════════════════════════`);
	logger.info(`  🚀 STARTUP COMPLETE (${timeStr})`);
	logger.info(`══════════════════════════════════════════════════════════════════\n`);
}

// ERROR IN CONTEXT -------------------------------------------------------------
export function logError(context: string, error: any) {
	logger.error(`${context} [${elapsed()}]`, { error });
}

