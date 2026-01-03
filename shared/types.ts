import { REDIS_KEYS, ALLOWED_IDS } from './constants.ts';

export type Privs = 'pub' | 'lin' | 'tru' | 'inv' | 'own';
export type UserMetaPrivs = Privs | 'ind';

export type ContentFilteringSets = 'links' | 'blocks' | 'invites' | 'trusts';
export type RedisKey = keyof typeof REDIS_KEYS;

export type Attends = 'sur' | 'may';
export type Inters = Attends | 'int';
export type InterChangeFlags = Inters | 'surMay' | 'surInt' | 'maySur' | 'mayInt' | 'intSur' | 'intMay' | 'minSur' | 'minMay' | 'minInt' | 'surPriv' | 'mayPriv' | 'intPriv' | 'del';

export type EventMeta = [UserMetaPrivs, string | null, number, string, string, string | null, number, number, number, number, number, number];
export type UserMeta = [Privs | 'ind', number, string, string, string, string, number, number, number, [string, Attends, Privs?][]];

// EVENT TYPES -----------------------------------------------------------------
export interface EventMetaInput {
	priv: UserMetaPrivs;
	owner: string | null;
	cityID: number;
	type: string;
	starts: string; // base36 timestamp string (DateMs.toString(36))
	geohash: string | null;
	surely: number;
	maybe: number;
	comments: number;
	score: number;
	basiVers: number;
	detaVers: number;
}

// EVENT BASI/DETA TYPES -------------------------------------------------------
// These are the object-shaped payloads stored separately from meta arrays.
// Source of truth: `backend/variables.ts` (eveBasiCols + eveDetailsCols).
export interface EventBasics {
	location?: string;
	place?: string;
	shortDesc?: string;
	title?: string;
	ends?: number;
	imgVers?: number;
	interrested?: number;
	canceled?: boolean;
	hashID?: string;
}

export interface EventDetails {
	meetHow?: string;
	meetWhen?: string;
	organizer?: string;
	contacts?: string;
	links?: string;
	detail?: string;
	fee?: string;
	takeWith?: string;
	location?: string;
}

export interface Event extends EventMetaInput, EventBasics, EventDetails {}

// USER TYPES ------------------------------------------------------------------
export interface UserMetaInput {
	priv: UserMetaPrivs;
	age: number;
	gender: string;
	indis: string;
	basics: string;
	groups: string;
	score: number;
	imgVers: number;
	basiVers: number;
	attend: [string, Attends, Privs?][];
}

export interface UserBasics {
	first: string;
	last: string;
	shortDesc: string;
	exps: string;
	favs: string;
}

export interface User extends UserMetaInput, UserBasics {}

export type Indicator = keyof typeof ALLOWED_IDS.indis;
export type Basic = keyof typeof ALLOWED_IDS.basics;
export type Group = keyof typeof ALLOWED_IDS.groups;
export type Type = keyof typeof ALLOWED_IDS.type;
