/** ----------------------------------------------------------------------------
 * SETUP PAYLOAD SANITIZER
 * Normalizes incoming profile fields before SQL updates:
 *  - trims strings, enforces allowed enums, strips empty values
 *  - handles birthdate parsing and coerces city arrays to expected format
 *  - toggles introduction-specific defaults when `isIntroduction` is true
 * Replace with actual implementation once ready.
 * --------------------------------------------------------------------------- */

import { ALLOWED_IDS, PRIVACIES_SET, GENDER_VALUES, MAX_COUNTS, MAX_CHARS, MIN_CHARS, MIN_COUNTS, REGEXES } from '../../../shared/constants';
import { checkFavouriteExpertTopicsQuality } from '../../../shared/utilities';

// VALIDATION CONSTANTS ---------------------------------------------------------
// Favex strict limits (mirror frontend `FavexAreas.jsx`)

// HELPER FUNCTIONS -------------------------------------------------------------
// ENSURE ARRAY -----------------------------------------------------------------
// Converts unknown inputs into an array to simplify sanitizer pipelines.
const ensureArray = value => (Array.isArray(value) ? value : []);

// SANITIZE USER NAME -----------------------------------------------------------
// Validates name format, length, and character set using Unicode letter patterns
function sanitizeName(value, code) {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new Error(code);
	const trimmed = value.trim();
	if (trimmed.length < 2 || trimmed.length > 40) throw new Error(code);
	if (!REGEXES.name.test(trimmed)) throw new Error(code);
	return trimmed;
}

// SANITIZE BIRTH DATE ----------------------------------------------------------
// Validates date format, calculates age, and ensures user is between 13-110 years old
// Returns ISO date string (YYYY-MM-DD) for database storage
function sanitizeBirth(value) {
	if (value === undefined) return undefined;
	// MS-ONLY INPUT -------------------------------------------------------------
	// Frontend guarantees ms timestamps due to axios request normalizer.
	const birthMs = typeof value === 'number' && Number.isFinite(value) ? value : /^\d{10,13}$/.test(String(value).trim()) ? Number(value) : NaN;
	if (!Number.isFinite(birthMs)) throw new Error('badRequest');

	// UTC AGE CHECK -------------------------------------------------------------
	// Use UTC components so timezone never shifts the "birthday day".
	const [birthDate, nowDate] = [new Date(birthMs), new Date()];
	let age = nowDate.getUTCFullYear() - birthDate.getUTCFullYear();
	const hadBirthday = nowDate.getUTCMonth() > birthDate.getUTCMonth() || (nowDate.getUTCMonth() === birthDate.getUTCMonth() && nowDate.getUTCDate() >= birthDate.getUTCDate());
	if (!hadBirthday) age -= 1;
	if (age < 13 || age > 110) throw new Error('badRequest');

	// DB FORMAT (DATE) ----------------------------------------------------------
	// Store date-only in UTC.
	return birthDate.toISOString().slice(0, 10);
}

// SANITIZE TOPICS (FAVORITES/EXPERIENCES) --------------------------------------
// Validates topic strings, removes duplicates (case-insensitive), enforces length limits
// Ensures minimum items requirement and total character count doesn't exceed 600
function sanitizeTopics(value, { minItems = 0 } = {}) {
	const topics = ensureArray(value)
		.filter(topic => typeof topic === 'string')
		.map(topic => topic.trim())
		.filter(Boolean);
	const deduped = [];
	const seen = new Set();
	for (const topic of topics) {
		if (topic.length < MIN_CHARS.favourExpertTopic) throw new Error('badRequest');
		// Favex: strict validation (letters + spaces, must start/end with a letter)
		if (!REGEXES.favouriteExpertTopic.test(topic)) throw new Error('badRequest');
		const lowered = topic.toLowerCase();
		if (seen.has(lowered)) continue;
		seen.add(lowered);
		deduped.push(topic);
	}
	if (deduped.length < minItems) throw new Error('badRequest');
	return deduped;
}

// SANITIZE ID LIST (BASICS/INDICATORS/GROUPS) ----------------------------------
// Validates list items against allowed IDs set, removes duplicates
// Used for basics, indicators, and groups arrays
function sanitizeIDList(value, { minItems = 0, allowedSet = new Set(), maxItems = 50 } = {}) {
	const list = ensureArray(value);
	const normalized = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === undefined || entry === null) continue;
		// Try numeric conversion for numeric allowed sets
		const item = typeof entry === 'string' && /^\d+$/.test(entry) ? Number(entry) : entry;
	if (!allowedSet.has(item)) continue;
		if (seen.has(item)) continue;
		seen.add(item);
		normalized.push(item);
		if (normalized.length >= maxItems) break;
	}
	if (normalized.length < minItems) throw new Error('badRequest');
	return normalized;
}

// SANITIZE CITIES ARRAY --------------------------------------------------------
// Normalizes city entries to either numeric IDs or hashID objects
// Handles multiple input formats: numbers, strings (numeric or hash), or objects
// Removes duplicates and limits to 10 cities maximum
function sanitizeCities(value, { minItems = 0, maxItems = MAX_COUNTS.cities } = {}) {
	if (value === undefined) return undefined;
	const list = ensureArray(value);
	const sanitized = [];
	const seen = new Set();
	for (const entry of list) {
		let formatted;
		if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) {
			if (seen.has(`id:${entry}`)) continue;
			seen.add(`id:${entry}`);
			formatted = entry;
		} else if (typeof entry === 'string') {
			const trimmed = entry.trim();
			if (!trimmed) continue;
			if (/^\d+$/.test(trimmed)) {
				const id = Number(trimmed);
				if (!Number.isInteger(id)) throw new Error('badRequest');
				if (seen.has(`id:${id}`)) continue;
				seen.add(`id:${id}`);
				formatted = id;
			} else {
				if (seen.has(`hash:${trimmed}`)) continue;
				seen.add(`hash:${trimmed}`);
				formatted = { hashID: trimmed };
			}
		} else if (entry && typeof entry === 'object') {
			if (Number.isInteger(entry.cityID)) {
				if (seen.has(`id:${entry.cityID}`)) continue;
				seen.add(`id:${entry.cityID}`);
				formatted = entry.cityID;
			} else if (typeof entry.hashID === 'string' && entry.hashID.trim()) {
				const hash = entry.hashID.trim();
				if (seen.has(`hash:${hash}`)) continue;
				seen.add(`hash:${hash}`);
				formatted = { hashID: hash };
			} else continue;
		} else continue;
		sanitized.push(formatted);
		if (sanitized.length >= maxItems) break;
	}
	if (sanitized.length < minItems) throw new Error('badRequest');
	return sanitized;
}

// NORMALIZE SETUP PAYLOAD ------------------------------------------------------
// Main validation function that sanitizes all user setup/profile fields
// For introductions, enforces required fields (first, last, birth, gender, cities, favs, basics)
// Removes defPriv if privacy is not 'ind' (individual privacy mode)
// Steps: sanitize each domain field (names/birth/favex/ids/cities), enforce introduction-required minimums, then drop invalid/extra fields so SQL update remains narrow.
function normalizeSetupPayload(input: any, { isIntroduction }: any) {
	const payload: any = {};
	const first = sanitizeName(input.first, 'badRequest');
	const last = sanitizeName(input.last, 'badRequest');
	if (first !== undefined) payload.first = first;
	if (last !== undefined) payload.last = last;

	const birth = sanitizeBirth(input.birth);
	if (birth !== undefined) payload.birth = birth;

	if (input.gender !== undefined) {
		const gender = String(input.gender).trim().toLowerCase();
		if (!GENDER_VALUES.includes(gender as any)) throw new Error('badRequest');
		payload.gender = gender as any;
	}

	if (input.shortDesc !== undefined) {
		if (typeof input.shortDesc !== 'string') throw new Error('badRequest');
		const shortDesc = input.shortDesc.trim();
		if (shortDesc.length > MAX_CHARS.userShortDesc) throw new Error('badRequest');
		payload.shortDesc = shortDesc;
	}

	if (input.priv !== undefined) {
		const priv = String(input.priv).trim();
		if (!PRIVACIES_SET.has(priv as any)) throw new Error('badRequest');
		payload.priv = priv as any;
	}

	if (input.defPriv !== undefined) {
		const defPriv = String(input.defPriv).trim();
		if (!PRIVACIES_SET.has(defPriv as any)) throw new Error('badRequest');
		payload.defPriv = defPriv as any;
	}

	if (input.askPriv !== undefined) payload.askPriv = Boolean(input.askPriv);

	if (input.favs !== undefined) payload.favs = sanitizeTopics(input.favs, { minItems: isIntroduction ? MIN_COUNTS.favouriteTopics : 0 });
	if (input.exps !== undefined) payload.exps = sanitizeTopics(input.exps);
	// FAVEX TOTAL CHAR LIMIT ------------------------------------------------------
	// Limit applies across BOTH categories combined (favs + exps).
	const favexTotalChars = [...(payload.favs || []), ...(payload.exps || [])].reduce((total, topic) => total + String(topic || '').length, 0);
	if (favexTotalChars > MAX_CHARS.favourExpertTopics) throw new Error('badRequest');
	// FAVEX QUALITY HEURISTICS ---------------------------------------------------
	// Centralized logic; threshold for short words is <=3 (shared/utilities.js).
	if (checkFavouriteExpertTopicsQuality({ favs: payload.favs, exps: payload.exps, shortWordMaxLength: 3 }).length) throw new Error('badRequest');

	if (input.basics !== undefined) payload.basics = sanitizeIDList(input.basics, { minItems: isIntroduction ? 3 : 0, allowedSet: ALLOWED_IDS.basics, maxItems: MAX_COUNTS.basics });
	if (input.indis !== undefined) payload.indis = sanitizeIDList(input.indis, { allowedSet: ALLOWED_IDS.indis, maxItems: MAX_COUNTS.indis });
	if (input.groups !== undefined) payload.groups = sanitizeIDList(input.groups, { allowedSet: ALLOWED_IDS.groups, maxItems: MAX_COUNTS.groups });
	if (input.cities !== undefined) payload.cities = sanitizeCities(input.cities, { minItems: isIntroduction ? 1 : 0, maxItems: MAX_COUNTS.cities });

	if (input.imgVers !== undefined) {
		const vImg = Number(input.imgVers);
		if (!Number.isInteger(vImg) || vImg < 0) throw new Error('badRequest');
		payload.imgVers = vImg;
	}

	if (isIntroduction) {
		['first', 'last', 'birth', 'gender', 'cities', 'indis', 'basics', 'favs'].forEach(field => {
			if (!payload[field]) throw new Error('badRequest');
		});
	}

	if (payload.priv !== 'ind') delete payload.defPriv;
	return payload;
}

export { normalizeSetupPayload };
