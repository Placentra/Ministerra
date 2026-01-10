import { REDIS_KEYS } from '../../shared/constants.ts';

const { blocks, links, trusts, invites } = REDIS_KEYS;
const redisKeys: Record<string, string> = { blocks, lin: links, tru: trusts, inv: invites };

let redis: any;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Steps: inject note-only redis dependency so filter helpers stay pure and testable.
const ioRedisSetter = (c: any): any => (redis = c);

interface FilterCommentsProps {
	items: any[];
	blocks: Set<string | number>;
}

// FILTER COMMENTS ----------------------------------------------------------------------
// Steps: build a lookup map, then for each comment: drop if author is blocked, else walk the reply chain upwards; if any ancestor
// is blocked (or chain is corrupt), emit `{}` so blocked users cannot leak visibility through nested replies.
const filterComments = ({ items, blocks }: FilterCommentsProps): any[] => {
	const commentMap: Map<string | number, any> = new Map(items.map(c => [c.id, c])),
		filteredComms: any[] = [];

	for (const c of items) {
		// AUTHOR GATE ---
		// Steps: hard-drop early so we do not waste time walking reply chains for already-blocked authors.
		if (blocks.has(c.user)) {
			filteredComms.push({});
			continue;
		}

		// TOP-LEVEL COMMENTS ---
		// Steps: no parent chain to verify, pass through directly.
		if (!c.target) {
			filteredComms.push(c);
			continue;
		}

		// ANCESTOR WALK ---
		// Steps: traverse target pointers until root, tracking visited IDs to detect cycles.
		let targetCommID: string | number | undefined = c.target,
			chainBlocked: boolean = false,
			reachedRoot: boolean = false,
			visited: Set<string | number> = new Set();

		while (targetCommID && !visited.has(targetCommID)) {
			visited.add(targetCommID);
			const targetComm: any = commentMap.get(targetCommID);

			// PARENT MISSING ---
			// Steps: if parent not in result set, assume chain is unverifiable; allow comment through
			// since the parent was likely filtered by pagination, not by block.
			if (!targetComm) {
				reachedRoot = true;
				break;
			}

			// BLOCKED ANCESTOR ---
			// Steps: ancestor authored by blocked user; redact this comment.
			if (blocks.has(targetComm.user)) {
				chainBlocked = true;
				break;
			}

			// REACHED ROOT ---
			if (!targetComm.target) {
				reachedRoot = true;
				break;
			}

			targetCommID = targetComm.target;
		}

		// CYCLE DETECTION ---
		// Steps: if loop exited because targetCommID was already visited, we have a cycle; treat as corrupt.
		const hasCycle: boolean = !!(targetCommID && visited.has(targetCommID) && !reachedRoot && !chainBlocked);

		// EMIT RESULT ---
		filteredComms.push(chainBlocked || hasCycle ? {} : c);
	}
	return filteredComms;
};

interface CheckRedisAccessProps {
	items: any[];
	userID: string | number;
}

// CHECK REDIS ACCESS ------------------------------------------------------------
// Steps: pre-scan items to build membership queries (blocks/lin/tru/inv), run them in one pipeline, then re-map each item to
// either the original object (permitted) or `{}` (redacted) with blocks taking absolute precedence.
async function checkRedisAccess({ items, userID }: CheckRedisAccessProps): Promise<any[]> {
	if (!Array.isArray(items) || !items.length) return items;

	// We use 'Set<string | number>' to handle potentially mixed ID types
	const divided: Record<string, Set<string | number>> = { blocks: new Set(), lin: new Set(), tru: new Set(), inv: new Set() };

	const owned: Set<string | number> = new Set(),
		pub: Set<string | number> = new Set(),
		privMap: Map<string | number, { priv: string; id: string | number }> = new Map();

	// REQUEST BUILD ---
	// Steps: compute the minimal set membership checks required to decide access for the whole batch.
	for (const item of items) {
		if (!item) continue;
		const { id, priv, owner } = item,
			ownerId: string | number = owner ?? id;

		// ANNOTATION STRATEGY: Strict Comparisons -----------------------------
		// We cast to String for safety if we are unsure, but if types are aligned we can compare directly.
		if (ownerId === userID) {
			owned.add(id);
			continue;
		}
		divided.blocks.add(ownerId); // Always check blocks
		if (!priv || priv === 'pub') pub.add(id);
		else if (priv === 'lin' || priv === 'tru') {
			divided[priv].add(ownerId);
			privMap.set(id, { priv, id: ownerId });
		} else if (priv === 'inv') {
			divided.inv.add(id);
			privMap.set(id, { priv: 'inv', id });
		}
	}

	// PIPELINE MEMBERSHIP ---
	// Steps: call smismember once per permission set, then map results back into per-priv lookup maps.
	const pipe: any = redis.pipeline();

	const checks: { priv: string; ids: (string | number)[] }[] = Object.entries(divided)
		.filter(([, s]) => s.size)
		.map(([priv, set]) => ({ priv, ids: [...set] }));

	checks.forEach(({ priv, ids }) => pipe.smismember(`${redisKeys[priv]}:${userID}`, ...ids));
	const perms: Record<string, Map<string | number, boolean>> = { blocks: new Map(), lin: new Map(), tru: new Map(), inv: new Map() };

	if (checks.length) {
		const results: any[] | null = await pipe.exec();
		if (results) {
			results.forEach(([, vals], i) => {
				if (Array.isArray(vals)) {
					vals.forEach((v, idx) => {
						perms[checks[i].priv].set(checks[i].ids[idx], !!v);
					});
				}
			});
		}
	}

	// FINAL GATE ---
	// Steps: allow owned; allow public if not blocked; otherwise require matching membership in the corresponding set.
	return items.map(item => {
		if (!item) return {};
		const { id, priv, owner } = item,
			ownerId: string | number = owner ?? id;
		// Allow if owned OR (public AND not blocked)
		if (owned.has(id) || ((!priv || priv === 'pub' || pub.has(id)) && !perms.blocks.get(ownerId))) return item;
		if (perms.blocks.get(ownerId)) return {};

		const info: { priv: string; id: string | number } | undefined = privMap.get(id);
		return info && perms[info.priv].get(info.id) ? item : {};
	});
}

export { filterComments, checkRedisAccess, ioRedisSetter };
