// WORKER LOADER WRAPPER --------------------------------------------------------
// Uses tsx programmatically to load worker.ts, avoiding loader registration issues.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let registered = false;

// TSX REGISTRATION -------------------------------------------------------------
// Prefer tsx/esm/api, fallback to node:module register, then last-resort tsx/esm import.
try {
	const tsxApi = await import('tsx/esm/api');
	if (tsxApi && tsxApi.register) {
		tsxApi.register();
		registered = true;
	}
} catch (err) {
}

if (!registered) {
	try {
		const tsxLoaderPath = path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs');
		const tsxLoaderUrl = pathToFileURL(tsxLoaderPath).href;
		register(tsxLoaderUrl, import.meta.url);
		registered = true;
	} catch (err) {
	}
}

if (!registered) {
	try {
		await import('tsx/esm');
		registered = true;
	} catch (err) {
	}
}

// Now import the actual worker - tsx loader will handle .ts resolution
if (!registered) throw new Error('Failed to register tsx loader for worker thread');
await import('./worker.ts');
