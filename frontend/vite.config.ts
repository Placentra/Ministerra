import { defineConfig } from 'vite';
import type { Plugin, PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

function devRestartPlugin(): Plugin {
	// DEV RESTART PLUGIN -------------------------------------------------------
	// Steps: register a dev-only middleware endpoint that touches a marker file; external watchers can use the marker to restart the dev process deterministically.
	return {
		name: 'dev-restart-plugin',
		apply: 'serve' as const,
		configureServer(server) {
			server.middlewares.use('/__restart', (req, res) => {
				// DEV RESTART ENDPOINT -------------------------------------------
				// Steps: lock to localhost, optionally require token, then write a timestamp marker; reject everything else to avoid LAN abuse.
				const remote = req.socket?.remoteAddress || '',
					isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1',
					expected = process.env.DEV_RESTART_TOKEN || '';
				if (!isLocal) return (res.statusCode = 403), res.end('forbidden');
				if (expected && req.headers['x-dev-restart-token'] !== expected) return (res.statusCode = 403), res.end('forbidden');
				console.log('[dev] Restart endpoint hit', req.method, req.url);
				try {
					const markerPath = path.resolve(process.cwd(), '.dev-restart');
					const stamp = new Date().toISOString() + (req.url ? ` ${req.url}` : '');
					fs.writeFileSync(markerPath, stamp);
					res.statusCode = 200;
					res.end('ok');
				} catch (err) {
					console.error('[dev] Restart endpoint error', err);
					res.statusCode = 500;
					res.end('error');
				}
			});
		},
	};
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
	appType: 'spa' as const, // THIS IS SPA ROUTING --- explicit, avoid relying on ignored options
	server: {
		// DEV SERVER ---------------------------------------------------------
		// Steps: bind to 0.0.0.0 for LAN testing, keep HMR on, use polling watch for Windows/Docker FS consistency.
		host: '0.0.0.0',
		hmr: true,
		watch: { usePolling: true, interval: 100 },
	},
	plugins: (() => {
		// PLUGINS ------------------------------------------------------------
		// Steps: normalize react() into a flat PluginOption[]; plugin-react returns Plugin | Plugin[] depending on config.
		const reactPlugin = react({
			// babel: {
			// 	plugins: [['babel-plugin-react-compiler']],
			// },
		});
		const reactPlugins: PluginOption[] = Array.isArray(reactPlugin) ? reactPlugin : [reactPlugin];
		return [...reactPlugins, devRestartPlugin()];
	})(),
	optimizeDeps: {
		esbuildOptions: {
			mainFields: ['module', 'main'],
			resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
		},
	},
}));
