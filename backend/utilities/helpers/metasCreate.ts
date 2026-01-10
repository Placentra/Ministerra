// CONTENT META ARRAYS ==========================================================
// Compact array format for event/user metadata (bandwidth optimization).
// Frontend unpacks these using the same index positions.
// =============================================================================

// META INDEXES ------------------------------------------
import { META_INDEXES_SOURCE } from '../../../shared/constants.ts';
import type { EventMeta, UserMeta, EventMetaInput, UserMetaInput } from '../../../shared/types.ts';

// CREATE EVENT META ARRAY ------------------------------------------------------
export function createEveMeta(inp: EventMetaInput): EventMeta {
	const meta: any[] = [];
	const eventIndexes: Record<string, number> = META_INDEXES_SOURCE.event as Record<string, number>;
	Object.keys(eventIndexes).forEach(key => (meta[eventIndexes[key]] = (inp as any)[key]));
	return meta as EventMeta;
}

// CREATE USER META ARRAY -------------------------------------------------------
export function createUserMeta(inp: UserMetaInput): UserMeta {
	const meta: any[] = [];
	const userIndexes: Record<string, number> = META_INDEXES_SOURCE.user as Record<string, number>;
	Object.keys(userIndexes).forEach(key => (meta[userIndexes[key]] = (inp as any)[key]));
	return meta as UserMeta;
}
