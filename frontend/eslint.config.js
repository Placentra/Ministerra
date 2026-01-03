import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
	{
		ignores: ['node_modules/**', 'dist/**', 'public/**'],
	},
	js.configs.recommended,
	{
		files: ['**/*.{js,jsx}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: {
				ecmaFeatures: {
					jsx: true,
				},
			},
			globals: {
				...globals.browser,
				...globals.es2022,
			},
		},
		plugins: {
			react,
			'react-hooks': reactHooks,
		},
		settings: {
			react: { version: 'detect' },
		},
		rules: {
			...react.configs.recommended.rules,
			...reactHooks.configs.recommended.rules,

			// Common modern React settings
			'react/react-in-jsx-scope': 'off',
			'react/jsx-uses-react': 'off',
			'react/prop-types': 'off',

			// Turn correctness back on (non-style)
			'react-hooks/exhaustive-deps': 'off',
			'no-unused-vars': 'off',
			'no-empty': ['error', { allowEmptyCatch: true }],
		},
	},
	{
		files: ['**/*.{ts,tsx}'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: {
				ecmaFeatures: {
					jsx: true,
				},
			},
			globals: {
				...globals.browser,
				...globals.es2022,
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
			react,
			'react-hooks': reactHooks,
		},
		settings: {
			react: { version: 'detect' },
		},
		rules: {
			// TS PARSING ONLY ------------------------------------------------------
			// Keep lint focused on JS/React correctness; avoid introducing new TS rule noise.
			'@typescript-eslint/no-unused-expressions': 'off',
			'@typescript-eslint/no-unused-vars': 'off',

			...react.configs.recommended.rules,
			...reactHooks.configs.recommended.rules,

			// Common modern React settings
			'react/react-in-jsx-scope': 'off',
			'react/jsx-uses-react': 'off',
			'react/prop-types': 'off',

			// Turn correctness back on (non-style)
			'react-hooks/exhaustive-deps': 'off',
			'no-unused-vars': 'off',
			'no-empty': ['error', { allowEmptyCatch: true }],
		},
	},
];
