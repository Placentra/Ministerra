import { useCallback } from 'react';
import { useErrorContext } from '../contexts/ErrorContext';

const DEFAULT_MESSAGE = 'Something went wrong. Please try again.';
const PREFERRED_KEYS = ['message', 'error', 'detail', 'info', 'reason', 'description'];

// UTILITY HELPERS -------------------------------------------------------------
// Steps: normalize unknown values into safe strings so extraction logic can branch cleanly without throwing.
const normalizeString = value => (typeof value === 'string' ? value.trim() : '');

// ITERABLE STRING PICKER ------------------------------------------------------
// Steps: extract the first non-empty string from arrays so backends that return {errors:[...]} still surface something human-readable.
const fromIterable = value => {
	if (!value) return '';
	if (Array.isArray(value)) {
		const first = value.find(item => typeof item === 'string' && item.trim().length);
		return normalizeString(first);
	}
	return '';
};

// ERROR PARSING LOGIC ---------------------------------------------------------
// Steps: prefer structured axios response payloads (string or object keys), then fallback to error.message, then fallback to stringified error, otherwise use caller-provided fallback.
export const extractErrorMessage = (error, fallback = DEFAULT_MESSAGE) => {
	if (!error) return fallback;

	const responseData = error.response?.data ?? error.data ?? error.payload;

	const stringResponse = normalizeString(responseData);
	if (stringResponse) return stringResponse;

	if (typeof responseData === 'object' && responseData !== null) {
		for (const key of PREFERRED_KEYS) {
			const value = responseData[key];
			const asString = normalizeString(value);
			if (asString) return asString;
			const fromArray = fromIterable(value);
			if (fromArray) return fromArray;
		}
	}

	const message = normalizeString(error.message);
	if (message) return message;

	const stringError = normalizeString(error);
	if (stringError) return stringError;

	return fallback;
};

// GLOBAL ERROR NOTIFICATION ---------------------------------------------------
// Accessible outside of React components
// Steps: skip when wipe is in progress, derive message via extractErrorMessage, try global error UI hook, otherwise log, then annotate error object to prevent duplicate displays.
export const notifyGlobalError = (error, fallbackMessage = DEFAULT_MESSAGE) => {
	if (typeof window !== 'undefined' && window.__wipeInProgress) return fallbackMessage;
	const message = extractErrorMessage(error, fallbackMessage);
	if (typeof window !== 'undefined' && typeof window.__showGlobalError === 'function') window.__showGlobalError(message);
	else console.error(message, error);
	if (error && typeof error === 'object') error.__globalErrorDisplayed = message;
	return message;
};

/** ----------------------------------------------------------------------------
 * USE ERRORS MANAGER HOOK
 * Provides access to the error context and notification system.
 * Prevents redundant error displays if already handled.
 * -------------------------------------------------------------------------- */
const useErrorsMan = (_opts?: any) => {
	const { showError } = useErrorContext() || {};

	return useCallback(
		(error, fallbackMessage = DEFAULT_MESSAGE) => {
			// DEDUPE -----------------------------------------------------------
			// Steps: reuse message already shown by global error path (unless caller overrides fallback), then mark error so other layers can skip re-reporting.
			if (error && typeof error === 'object' && typeof error.__globalErrorDisplayed === 'string' && (!fallbackMessage || fallbackMessage === DEFAULT_MESSAGE)) {
				return error.__globalErrorDisplayed;
			}
			if (error && typeof error === 'object') error.__handledByErrorMan = true;
			if (typeof showError === 'function') {
				const message = extractErrorMessage(error, fallbackMessage);
				(showError as any)(message);
				error && typeof error === 'object' && (error.__globalErrorDisplayed = message);
				return message;
			}
			return notifyGlobalError(error, fallbackMessage);
		},
		[showError]
	);
};

export default useErrorsMan;
