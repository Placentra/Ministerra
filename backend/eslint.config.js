import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
	{
		ignores: [
			'node_modules/**',
			'logs/**',
			'logging/**',
			'databaseBackups/**',
			'failedSqlWrites/**',
			'writeFailures/**',
			'public/**',
			'**/*.sql',
			'**/*.log',
			'**/*.log.gz',
			'**/*.out',
		],
	},
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.es2022,
			},
		},
		rules: {
			'no-inline-styles': 'off',
			'no-unused-vars': 'warn',
			'no-console': 'off',
			// Codebase uses empty catch blocks intentionally in a few places (catch-and-ignore)
			'no-empty': ['error', { allowEmptyCatch: true }],
			// Some sanitizers intentionally use control chars in regexes
			'no-control-regex': 'off',
			// Keep signal, but don't fail the whole lint run for these patterns in v1
			'no-constant-condition': 'warn',
			'no-extra-boolean-cast': 'warn',
		},
	},
	{
		files: ['**/*.{ts,tsx}'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.es2022,
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
		},
		rules: {
			// TS PARSING ONLY ------------------------------------------------------
			// This codebase intentionally uses dense comma sequencing and other patterns
			// that are not compatible with @typescript-eslint recommended defaults.
			'@typescript-eslint/no-unused-expressions': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
];


