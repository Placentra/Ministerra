// FILE CLEANUP =================================================================
import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '../../systems/handlers/loggers.ts';

const logger = getLogger('Task:DailyRecalc:FileCleanup');

/** Remove images for deleted users and events from the public filesystem. */
// Steps: list directory, filter by id prefix, unlink matching files, and log failures without aborting the whole cleanup sweep.
export async function cleanupDeletedFiles({ delUse, delEve }) {
	const tasks = [];
	if (delUse?.size) tasks.push(cleanupDirectory('public/users', delUse));
	if (delEve?.size) tasks.push(cleanupDirectory('public/events', delEve));
	if (tasks.length) await Promise.all(tasks);
}

// CLEANUP ONE DIRECTORY --------------------------------------------------------
// Steps: verify directory exists, compute deletions by id prefix, unlink in parallel, and ignore ENOENT directory cases (deploys without local fs assets).
async function cleanupDirectory(dir, ids) {
	try {
		await fs.access(dir);
		const deletions = (await fs.readdir(dir))
			.filter(f => ids.has(f.split('_')[0]))
			.map(f => fs.unlink(path.join(dir, f)).catch(error => logger.error('dailyRecalc.file_cleanup_failed', { error, f, dir })));
		if (deletions.length) {
			await Promise.all(deletions);
			logger.info('dailyRecalc.files_cleaned', { dir, count: deletions.length });
		}
	} catch (error) {
		if (error.code !== 'ENOENT') logger.error('dailyRecalc.dir_cleanup_failed', { error, dir });
	}
}
