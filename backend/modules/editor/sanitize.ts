import { ALLOWED_IDS, MAX_EVENT_DURATIONS } from '../../../shared/constants.ts';

// VALIDATION CONSTANTS ---------------------------------------------------------
const ALLOWED_MODES = new Set(['delete', 'cancel', 'create', 'edit', undefined]);
const ALLOWED_PRIVS = new Set(['pub', 'lin', 'own', 'tru', 'inv']);
const ALLOWED_INTERS = new Set(['sur', 'may', 'int', null]);
const ALLOWED_LOCA_MODES = new Set(['city', 'radius', 'exact']);
const ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;

// TODO need to unify these limits across frontend, sanitizers and DB! Should probably  create some scripts, which also update the ALTER TABLE statems in dbSchema and run those.

const STRING_LIMITS = {
	title: 150,
	shortDesc: 300,
	place: 200,
	location: 200,
	city: 100,
	part: 100,
	meetHow: 300,
	detail: 5000,
	contacts: 500,
	fee: 200,
	organizer: 200,
	links: 1000,
	takeWith: 500,
};

// HELPER FUNCTIONS -------------------------------------------------------------
// Steps: sanitize scalar fields first, then sanitize compound fields (city, coords, dates), then assemble a final payload with undefined fields removed.
function sanitizeString(str, maxLength = 500) {
	if (str === undefined || str === null) return undefined;
	if (typeof str !== 'string') throw new Error('invalid string input');
	let sanitized = str.trim().slice(0, maxLength);
	sanitized = sanitized.replace(/\0/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
	return sanitized;
}

// SANITIZE CITY VALUE ----------------------------------------------------------
// Accepts city objects from geocoder payloads by picking a display name and keeping geo metadata.
function sanitizeCityValue(value) {
	if (value === undefined) return undefined;
	const limit = STRING_LIMITS.city || 500;
	if (typeof value === 'string') return { city: sanitizeString(value, limit) };
	if (value && typeof value === 'object') {
		const sanitizedObj = { ...value };
		const cityName = ['city', 'label', 'name', 'title'].map(key => value[key]).find(val => typeof val === 'string' && val.trim());
		if (!cityName) throw new Error('invalid city');
		sanitizedObj.city = sanitizeString(cityName, limit);
		['part', 'country', 'region', 'county', 'label', 'name', 'title', 'hashID'].forEach(key => typeof value[key] === 'string' && (sanitizedObj[key] = sanitizeString(value[key], limit)));
		if (value.lat !== undefined) sanitizedObj.lat = sanitizeLatitude(value.lat);
		if (value.lng !== undefined) sanitizedObj.lng = sanitizeLongitude(value.lng);
		return sanitizedObj;
	}
	throw new Error('invalid city');
}

// SANITIZE STRING FIELD --------------------------------------------------------
function sanitizeStringField(value, field) {
	if (value === undefined) return undefined;
	if (field === 'city') return sanitizeCityValue(value);
	if (typeof value !== 'string') throw new Error(`invalid ${field}`);
	return sanitizeString(value, STRING_LIMITS[field] || 500);
}

// SANITIZE NUMERIC FIELDS ------------------------------------------------------
function sanitizeType(value) {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new Error('invalid type');
	if (!ALLOWED_IDS.type.has(value)) throw new Error('invalid type');
	return value;
}

function sanitizeLatitude(value) {
	if (value === undefined) return undefined;
	const num = Number(value);
	if (isNaN(num) || num < -90 || num > 90) throw new Error('invalid latitude');
	return num;
}

function sanitizeLongitude(value) {
	if (value === undefined) return undefined;
	const num = Number(value);
	if (isNaN(num) || num < -180 || num > 180) throw new Error('invalid longitude');
	return num;
}

function sanitizeCityID(value) {
	if (value === undefined) return undefined;
	const num = Number(value);
	if (!Number.isInteger(num) || num < 0) throw new Error('invalid cityID');
	return num;
}

// SANITIZE USER ID -------------------------------------------------------------
// Validates userID format (nanoid-style or test ID '1').
function sanitizeUserID(value) {
	if (!ID_REGEX.test(value) && value !== '1') throw new Error('invalid userID');
	return value;
}

// SANITIZE DATE FIELDS ---------------------------------------------------------
function sanitizeStartsDate(value, type, isEdit = false) {
	if (value === undefined) return undefined;
	const date = new Date(value);
	if (isNaN(date.getTime())) throw new Error('invalid starts date');
	if (isEdit) return value; // Allow past/current dates when editing existing events

	const now = Date.now();
	const tenMinutesFromNow = now + 10 * 60 * 1000;
	const twoYearsFromNow = now + 2 * 365 * 24 * 60 * 60 * 1000;
	// FRIENDLY EVENTS 6-WEEK LIMIT (ROUNDED TO END OF DAY) ---
	const sixWeeksEndOfDay = (() => {
		const endDate = new Date(now + 6 * 7 * 24 * 60 * 60 * 1000);
		endDate.setHours(23, 59, 59, 999);
		return endDate.getTime();
	})();
	const maxAllowed = type?.startsWith('a') ? sixWeeksEndOfDay : twoYearsFromNow;
	// RANGE GUARD -------------------------------------------------------------
	// Steps: reject starts that are too soon (anti-spam / avoids “already started”) or too far (keeps indexes stable and prevents pathological scheduling).
	if (date.getTime() < tenMinutesFromNow || date.getTime() > maxAllowed) {
		throw new Error('starts date out of reasonable range');
	}
	return value;
}

function sanitizeEndsDate(value, starts, type) {
	if (value === undefined) return undefined;
	const date = new Date(value);
	if (isNaN(date.getTime())) throw new Error('invalid ends date');
	if (starts && date.getTime() < new Date(starts).getTime()) {
		throw new Error('end date cannot be before start date');
	}
	if (starts) {
		const limit = type?.startsWith('a') ? MAX_EVENT_DURATIONS.friendly : MAX_EVENT_DURATIONS.regular;
		if (date.getTime() > new Date(starts).getTime() + limit) {
			throw new Error('event duration exceeds allowed limit');
		}
	}
	return value;
}

function sanitizeMeetWhen(value) {
	if (value === undefined) return undefined;
	const date = new Date(value);
	if (isNaN(date.getTime())) throw new Error('invalid meetWhen date');
	return value;
}

// SANITIZE ENUM FIELDS ---------------------------------------------------------
function sanitizeMode(value) {
	if (!ALLOWED_MODES.has(value)) throw new Error('invalid mode');
	return value;
}

function sanitizePriv(value) {
	if (value === undefined) return undefined;
	if (!ALLOWED_PRIVS.has(value)) throw new Error('invalid priv');
	return value;
}

function sanitizeInter(value) {
	if (value === undefined) return undefined;
	if (!ALLOWED_INTERS.has(value)) throw new Error('invalid inter');
	return value;
}

function sanitizeLocaMode(value) {
	if (value === undefined) return undefined;
	if (!ALLOWED_LOCA_MODES.has(value)) throw new Error('invalid locaMode');
	return value;
}

// SANITIZE V_IMG ---------------------------------------------------------------
function sanitizeVImg(value) {
	if (value === undefined) return undefined;
	const num = Number(value);
	if (isNaN(num)) throw new Error('invalid imgVers');
	return num;
}

// SANITIZE EVENT ID ------------------------------------------------------------
// Accepts nanoid-style identifiers used by events table and Redis keys.
function sanitizeEventID(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw new Error('invalid id');
	const id = value.trim();
	if (!ID_REGEX.test(id) && value !== '1') throw new Error('invalid id');
	return id;
}

// NORMALIZE EDITOR PAYLOAD -----------------------------------------------------
// Main validation function that sanitizes all event create/edit fields
// Returns sanitized payload object with validated fields
// Steps: sanitize each field via dedicated validators, then drop undefined fields so downstream logic can treat “missing” as “don’t change”.
function normalizeEditorPayload(input) {
	const mode = sanitizeMode(input.mode);
	const type = sanitizeType(input.type);

	const payload = {
		id: sanitizeEventID(input.id),
		mode,
		type,
		userID: sanitizeUserID(input.userID),
		title: sanitizeStringField(input.title, 'title'),
		shortDesc: sanitizeStringField(input.shortDesc, 'shortDesc'),
		place: sanitizeStringField(input.place, 'place'),
		location: sanitizeStringField(input.location, 'location'),
		city: sanitizeStringField(input.city, 'city'),
		part: sanitizeStringField(input.part, 'part'),
		meetHow: sanitizeStringField(input.meetHow, 'meetHow'),
		detail: sanitizeStringField(input.detail, 'detail'),
		contacts: sanitizeStringField(input.contacts, 'contacts'),
		fee: sanitizeStringField(input.fee, 'fee'),
		organizer: sanitizeStringField(input.organizer, 'organizer'),
		links: sanitizeStringField(input.links, 'links'),
		takeWith: sanitizeStringField(input.takeWith, 'takeWith'),
		lat: sanitizeLatitude(input.lat),
		lng: sanitizeLongitude(input.lng),
		cityID: sanitizeCityID(input.cityID),
		priv: sanitizePriv(input.priv),
		inter: sanitizeInter(input.inter),
		interPriv: sanitizePriv(input.interPriv),
		locaMode: sanitizeLocaMode(input.locaMode),
		starts: sanitizeStartsDate(input.starts, type, !!input.id),
		ends: sanitizeEndsDate(input.ends, input.starts, type),
		meetWhen: sanitizeMeetWhen(input.meetWhen),
		imgVers: sanitizeVImg(input.imgVers),
	};

	// Remove undefined values
	for (const key of Object.keys(payload)) {
		if (payload[key] === undefined) delete payload[key];
	}

	return payload;
}

export { normalizeEditorPayload };
