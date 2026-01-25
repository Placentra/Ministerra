import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

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
			prettier,
		},
		settings: {
			react: { version: 'detect' },
		},
		rules: {
			'no-inline-styles': 'off',
			...react.configs.recommended.rules,
			...reactHooks.configs.recommended.rules,
			...prettierConfig.rules,
			'prettier/prettier': 'warn',

			// Common modern React settings
			'react/react-in-jsx-scope': 'off',
			'react/jsx-uses-react': 'off',
			'react/prop-types': 'off',

			// INLINE STYLES ALLOWED ---
			'react/forbid-component-props': 'off',
			'react/forbid-dom-props': 'off',

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
			prettier,
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
			...prettierConfig.rules,
			'prettier/prettier': 'warn',

			// Common modern React settings
			'react/react-in-jsx-scope': 'off',
			'react/jsx-uses-react': 'off',
			'react/prop-types': 'off',

			// INLINE STYLES ALLOWED ---
			'react/forbid-component-props': 'off',
			'react/forbid-dom-props': 'off',

			// Turn correctness back on (non-style)
			'react-hooks/exhaustive-deps': 'off',
			'no-unused-vars': 'off',
			'no-empty': ['error', { allowEmptyCatch: true }],
		},
	},
];
