/** ----------------------------------------------------------------------------
 * OBJECT UTILITIES
 * Pure utility functions for object/array manipulation.
 * --------------------------------------------------------------------------- */

// CREATE SUBSET OBJECT ---------------------------------------------------------
// Steps: allocate a new plain object, then copy only requested props so callers can safely hand a minimal payload to API/storage without mutating source.
export function createSubsetObj(obj, props) {
	const newObj = {};
	props.forEach(prop => (newObj[prop] = obj[prop]));
	return newObj;
}

// DELETE UNDEFINED / EMPTY VALUES ----------------------------------------------
// Steps: keep Dates always, keep non-empty arrays/objects, optionally keep empty strings/false/0 based on flags; return undefined when result would be empty so callers can skip sending no-op payloads.
export function delUndef(obj, empStr = false, zeros = false, falses = false) {
	const trimmedObj = Object.keys(obj).reduce((acc, key) => {
		const value = obj[key];
		if (
			value instanceof Date ||
			(value && (Array.isArray(value) ? value.length : typeof value === 'object' ? Object.keys(value).length : value)) ||
			(empStr && value === '') ||
			(falses && value === false) ||
			(zeros && value === 0)
		)
			acc[key] = value;
		return acc;
	}, {});
	if (Object.keys(trimmedObj).length) return trimmedObj;
}

// TRIM SNAPSHOT (REMOVE INTERNAL PROPS) ----------------------------------------
// Steps: strip internal bookkeeping fields so the returned object is safe to serialize or compare (keeps semantic user-facing fields only).
export function trim(snap) {
	return Object.fromEntries(Object.entries(snap).filter(([key]) => !['id', 'init', 'last', 'sherChanged', 'changed', 'sherData', 'fetch'].includes(key)));
}

// SPLIT/REJOIN “ARRAY STRINGS” -------------------------------------------------
// Steps: normalize common persisted string fields into arrays (split) for runtime logic, or back into strings (join) for storage; keeps numeric lists numeric where expected.
export function splitStrgOrJoinArr(obj, method = 'split') {
	const applyMethod = (key, delimiter, isNum = false) => {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			if (method === 'split' && typeof obj[key] === 'string') obj[key] = obj[key]?.split(delimiter).map(item => (isNum ? Number(item) : item)) || [];
			else if (method === 'join' && Array.isArray(obj[key]) && !obj[key].some(item => typeof item === 'object')) obj[key] = obj[key].join(delimiter);
		}
	};
	['basics', 'indis', 'groups', 'cities'].forEach(key => applyMethod(key, ',', true));
	['favs', 'exps'].forEach(key => applyMethod(key, '|'));
	return obj;
}

// DEEP EQUALITY CHECK ----------------------------------------------------------
// Steps: short-circuit on null/type mismatch, recurse arrays by index, recurse objects by key set, and compare primitives directly; used to avoid unnecessary state writes.
export function areEqual(a, b) {
	if (a == null || b == null) return a === b;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((item, i) => areEqual(item, b[i]));
	}
	if (typeof a === 'object' && typeof b === 'object') {
		const [keysA, keysB] = [Object.keys(a), Object.keys(b)];
		if (keysA.length !== keysB.length) return false;
		return keysA.every(key => keysB.includes(key) && areEqual(a[key], b[key]));
	}
	return a === b;
}

// DEBOUNCE ---------------------------------------------------------------------
// Steps: collapse rapid calls into one scheduled call after wait; when immediate=true, fire once at the leading edge then suppress until wait elapses.
export function debounce(func, wait, immediate = false) {
	let timeout;
	return function (...args) {
		const context = this;
		const later = () => {
			timeout = null;
			if (!immediate) func.apply(context, args);
		};
		const callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) func.apply(context, args);
	};
}
