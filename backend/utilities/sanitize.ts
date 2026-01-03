// INPUT SANITIZERS -------------------------------------------------------------
// Steps: validate/normalize inbound payloads, reject or strip unsafe content, and prevent prototype pollution; used by HTTP middleware and Socket.IO payload guards.

// NOTE: express Request/Response/NextFunction were type-only imports; backend runtime does not need them.

// Control chars: backspace, vertical tab, form feed, range \u000E-\u001F and DEL. Do NOT include '-'.
const CONTROL_CHARS_REGEX = /[\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HTML_TAG_REGEX = /<[^>]*>/g;
const JS_URL_REGEX = /\b(?:javascript:|data:text\/html|vbscript:)/i;
const EVENT_HANDLER_ATTR_REGEX = /\bon[a-z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi;
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WS_MULTI_OR_EDGE_REGEX = /\s{2,}|^\s|\s$/;

const DEFAULTS = {
	maxString: 10_000,
	maxDepth: 3,
	maxArrayItems: 50,
	maxObjectKeys: 32,
	stringOptions: { allowHtml: false, stripEventAttrs: false, rejectIfJsProtocol: true, checkControlChars: false, maxLength: undefined },
	allowBuffer: false,
	allowDates: true,
};
const RELAXED_MAX_PAYLOAD_BYTES = Number(process.env.SANITIZE_RELAXED_MAX_BYTES || 20000);

// PLAIN OBJECT CHECK -----------------------------------------------------------
// Steps: accept only null-prototype or Object-prototype objects so we can safely iterate keys without walking arbitrary prototypes.

function isPlainObject(v) {
	return Object.prototype.toString.call(v) === '[object Object]' && (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype);
}

// STRING NORMALIZATION ---------------------------------------------------------
// Steps: collapse whitespace and trim; reject oversized strings early to keep sanitizer CPU bounded.
function normalizeString(s) {
	if (typeof s !== 'string') return s;
	if (s.length > DEFAULTS.maxString) return undefined; // Fail-fast on oversized
	return s.replace(/\s+/g, ' ').trim();
}

// FAST STRICT STRING CHECK -----------------------------------------------------
// Steps: return true only when sanitizeString would leave the string unchanged; used by strict validator to short-circuit quickly.
function isStringCleanStrict(s, opts = DEFAULTS.stringOptions) {
	if (typeof s !== 'string') return false;
	if (s.length > (opts.maxLength || DEFAULTS.maxString)) return false;
	if (opts.checkControlChars && CONTROL_CHARS_REGEX.test(s)) return false;
	if (opts.stripEventAttrs && EVENT_HANDLER_ATTR_REGEX.test(s)) return false;
	if (!opts.allowHtml && s.indexOf('<') !== -1 && HTML_TAG_REGEX.test(s)) return false;
	if (opts.rejectIfJsProtocol && JS_URL_REGEX.test(s)) return false;
	return true;
}

// STRING SANITIZE ---------------------------------------------------------
// Steps: normalize whitespace, optionally strip event handlers and html tags, reject js protocols, then reject (not truncate) strings over maxLen.
export function sanitizeString(s, opts = DEFAULTS.stringOptions) {
	if (typeof s !== 'string') return s;
	let str = normalizeString(s);
	if (str === undefined) return undefined;
	// Only run regex replaces if necessary
	if (opts.stripEventAttrs && EVENT_HANDLER_ATTR_REGEX.test(str)) str = str.replace(EVENT_HANDLER_ATTR_REGEX, '');
	if (!opts.allowHtml && str.indexOf('<') !== -1) str = str.replace(HTML_TAG_REGEX, '');
	if (opts.rejectIfJsProtocol && JS_URL_REGEX.test(str)) return undefined;
	const maxLen = opts.maxLength || DEFAULTS.maxString;
	if (str.length > maxLen) return undefined; // Stricter: reject, don't truncate
	return str;
}

// VALUE SANITIZE ----------------------------------------------------------
// Steps: recurse with depth cap, sanitize primitives, sanitize arrays/objects with size caps, and drop disallowed types so payload becomes safe to trust.
export function sanitizeValue(val, opts = DEFAULTS, depth = 0) {
	if (depth > opts.maxDepth) return undefined;
	if (val == null) return val;
	const t = typeof val;
	if (t === 'string') return sanitizeString(val, opts.stringOptions);
	if (t === 'number') return Number.isFinite(val) ? val : undefined;
	if (t === 'boolean') return val;
	if (t === 'bigint') {
		const n = Number(val);
		return Number.isSafeInteger(n) ? n : undefined;
	}
	if (t === 'symbol' || t === 'function') return undefined;

	// ARRAY SANITIZE -------------------------------------------------------
	// Steps: cap length, recurse each element, and drop undefined results; typed arrays are treated as arrays and are rejected by allowBuffer policy.
	if (Array.isArray(val) || ArrayBuffer.isView(val)) {
		const iterable = Array.isArray(val) ? val : Array.from(new Uint8Array(val.buffer, val.byteOffset, val.byteLength));
		if (iterable.length > opts.maxArrayItems) return undefined;
		let out = null;
		for (const item of iterable) {
			const v = sanitizeValue(item, opts, depth + 1);
			if (v !== undefined) {
				if (!out) out = [];
				out.push(v);
			}
		}
		return out || [];
	}

	if (isPlainObject(val)) {
		// OBJECT SANITIZE ------------------------------------------------------
		// Steps: cap key count, skip pollution keys, sanitize keys when needed, recurse values, and return a new object only when something survives.
		const keys = Object.keys(val);
		if (keys.length > opts.maxObjectKeys) return undefined;
		let out = null;
		for (const k of keys) {
			if (POLLUTION_KEYS.has(k) || k.startsWith('__')) continue;
			// Avoid allocating when key is already clean
			let sk = k;
			if (CONTROL_CHARS_REGEX.test(sk) || sk.indexOf('<') !== -1 || JS_URL_REGEX.test(sk) || WS_MULTI_OR_EDGE_REGEX.test(sk)) {
				sk = sanitizeString(k, { allowHtml: false, stripEventAttrs: false, rejectIfJsProtocol: true, checkControlChars: false, maxLength: undefined });
				if (sk === undefined) continue;
			}
			// Note: trim already handled inside sanitizeString when needed
			const v = sanitizeValue(val[k], opts, depth + 1);
			if (v !== undefined) {
				if (!out) out = {};
				out[sk] = v;
			}
		}
		return out || {};
	}

	if (Buffer.isBuffer(val)) return opts.allowBuffer ? val.toString('base64') : undefined;
	if (val instanceof Date) {
		if (!opts.allowDates) return undefined;
		const ts = val.getTime();
		return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
	}
	return undefined;
}

// Fast strict validator: returns true when payload is acceptable as-is.
// Short-circuits on first violation or when sanitization would change a value.
export function validateValueStrict(val, opts = DEFAULTS, depth = 0) {
	// STRICT VALIDATION -------------------------------------------------------
	// Steps: return false if sanitization would change anything or if payload violates caps; used to reject requests instead of mutating them.
	if (depth > opts.maxDepth) return false;
	if (val == null) return true;
	const t = typeof val;
	if (t === 'string') return isStringCleanStrict(val, opts.stringOptions);
	if (t === 'number') return Number.isFinite(val);
	if (t === 'boolean') return true;
	if (t === 'bigint') {
		const n = Number(val);
		return Number.isSafeInteger(n);
	}
	if (t === 'symbol' || t === 'function') return false;

	if (Array.isArray(val) || ArrayBuffer.isView(val)) {
		const arr = val;
		if (arr.length > opts.maxArrayItems) return false;
		for (const item of arr) if (!validateValueStrict(item, opts, depth + 1)) return false;
		return true;
	}

	if (isPlainObject(val)) {
		const keys = Object.keys(val);
		if (keys.length > opts.maxObjectKeys) return false;
		for (const k of keys) {
			if (POLLUTION_KEYS.has(k) || k.startsWith('__')) return false;
			if (!isStringCleanStrict(k, { allowHtml: false, stripEventAttrs: false, rejectIfJsProtocol: true, checkControlChars: false, maxLength: undefined })) return false;
			if (!validateValueStrict(val[k], opts, depth + 1)) return false;
		}
		return true;
	}

	// Buffer always rejected in strict mode (would be base64 encoded)
	if (Buffer.isBuffer(val)) return opts.allowBuffer === true;
	// Date accepted if allowDates is true and timestamp is valid
	if (val instanceof Date) return opts.allowDates !== false && Number.isFinite(val.getTime());
	return false;
}

//  IN-PLACE SANITIZE -------------------------------------------------------
// Steps: sanitize into a fresh object, then replace original keys in-place so downstream code can keep object identity.
export function sanitizeObjectInPlace(obj, opts = DEFAULTS, { failOnInvalid = true, logger = null } = {}) {
	//
	if (!isPlainObject(obj)) {
		if (failOnInvalid) throw new Error('Expected plain object');
		return obj;
	}
	const sanitized = sanitizeValue(obj, opts);
	if (!sanitized || typeof sanitized !== 'object') {
		if (logger?.alert) logger.alert('Payload rejected', { reason: 'Invalid after sanitization', size: JSON.stringify(obj).length });
		if (failOnInvalid) throw new Error('Payload rejected');
		return obj;
	}
	for (const k of Object.keys(obj)) delete obj[k];
	for (const [k, v] of Object.entries(sanitized)) obj[k] = v;
	return obj;
}

// EXPRESS MIDDLEWARE FACTORY ----------------------------------------------
// Steps: pick strict/relaxed mode by env, validate body (non-GET), and on failure return 400 or delegate to onReject.
export function createSanitizeRequestMiddleware(globalOptions = DEFAULTS, { onReject = null, logger = console } = {}) {
	const sanitizeMode = (process.env.SANITIZE_MODE || (process.env.LIGHT_MODE === '1' ? 'relaxed' : 'strict')).toLowerCase();

	return function sanitizeRequest(req, res, next) {
		try {
			if (isPlainObject(req.body) && req.method !== 'GET') {
				if (sanitizeMode === 'relaxed' && relaxedValidate(req.body)) return next();
				if (!validateValueStrict(req.body, globalOptions)) throw new Error('Invalid input');
			}
			next();
		} catch (err) {
			if (logger?.error) logger.error('Sanitizer error', { err: String(err), method: req.method, url: req.url });
			if (typeof onReject === 'function') return onReject(req, res, err);
			res.status(400).json({ error: process.env.NODE_ENV === 'production' ? 'Invalid input' : String(err) });
		}
	};
}

// RELAXED VALIDATION -----------------------------------------------------------
// Steps: cheap JSON size + key checks only; used for light mode to reduce CPU while still blocking obvious abuse.
function relaxedValidate(payload) {
	try {
		const json = JSON.stringify(payload);
		if (!json || json.length > RELAXED_MAX_PAYLOAD_BYTES) return false;
		// 'payload' is object-like because isPlainObject passed
		const keys = Object.keys(payload);
		if (keys.length > DEFAULTS.maxObjectKeys * 2) return false;
		for (const key of keys) {
			if (POLLUTION_KEYS.has(key) || key.startsWith('__')) return false;
		}
		return true;
	} catch {
		return false;
	}
}

// SOCKET PAYLOAD SANITIZE ------------------------------------------------
// Steps: sanitize value and return null on rejection so callers can drop the message without throwing.
export function sanitizeSocketPayload(payload, opts = DEFAULTS, logger = null) {
	try {
		const result = sanitizeValue(payload, opts);
		if (result === undefined) {
			if (logger?.alert) logger.alert('Socket payload rejected', { size: JSON.stringify(payload).length });
			return null;
		}
		return result;
	} catch (e) {
		if (logger?.error) logger.error('Socket sanitizer exception', { e: String(e) });
		return null;
	}
}

export const defaultMiddleware = createSanitizeRequestMiddleware(DEFAULTS, {
	onReject: (req, res) => res.status(400).json({ error: 'Invalid input' }),
	logger: console,
});

export default defaultMiddleware;
