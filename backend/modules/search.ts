import { Sql, Catcher } from '../systems/systems.ts';
import { checkRedisAccess } from '../utilities/contentFilters';
import { getLogger } from '../systems/handlers/loggers.ts';

const logger = getLogger('Search');
const MAX_OFFSET = 5000;

// CONSTANTS -------------------------------------------------------------------

const [usersCols, eveCols, matchUser, likeConc, fullText] = [
	'u.id, u.first, u.last, u.imgVers',
	'e.id, e.priv, e.owner, e.title, e.imgVers, e.starts, e.type',
	'MATCH(u.first, u.last)',
	"LIKE CONCAT(?, '%')",
	'AGAINST(? IN BOOLEAN MODE)',
];

// HELPERS ---------------------------------------------------------------------

// ESCAPE LIKE WILDCARDS --------------------------------------------------------
// Steps: escape %/_/backslash so LIKE queries don’t become wildcard-driven scans; keeps user intent (prefix match) while preventing abuse.
const escapeLikeWildcards = str => (typeof str === 'string' ? str.replace(/[%_\\]/g, '\\$&') : '');

// BOOLEAN FULLTEXT BUILDER -----------------------------------------------------
// Steps: split into tokens, strip boolean operators, drop short/noisy pieces, cap token count, then build `+token*` boolean query so MySQL stays in a sane query plan.
const buildBooleanFTS = raw => {
	if (!raw) return '';
	const tokens = raw
		.trim()
		.split(/\s+/)
		.map(t => t.replace(/[+\-~*><()"@]/g, ''))
		.filter(t => t.length >= 2)
		.slice(0, 6);
	return tokens.map(t => `+${t}*`).join(' ');
};

// QUERY BUILDER ---------------------------------------------------------------
// Constructs specialized SQL for chats, events, users, links or trusts circles.
// Toggles between FTS (MATCH...AGAINST) and LIKE based on mode/query availability.
// GET QUERY --------------------------------------------------------------------
// Steps: select the minimal SQL template per mode, toggle between FTS vs LIKE, and always clamp offset so deep paging can’t be used for resource exhaustion.
const getQuery = (mode, useFullText, offset) => {
	const limOff = `LIMIT 20 OFFSET ${Math.min(offset, MAX_OFFSET)}`;
	if (mode === 'chats')
		return /*sql*/ `SELECT c.id, c.name, c.type, cm.role, cm.flag, c.imgVers, CASE WHEN c.type = 'private' THEN CONCAT(other_u.id, ',', other_u.first, ',', other_u.last) ELSE c.name END AS userOrName FROM chats c JOIN chat_members cm ON c.id = cm.chat LEFT JOIN chat_members other_cm ON c.id = other_cm.chat AND other_cm.id != cm.id LEFT JOIN users other_u ON other_u.id = other_cm.id WHERE cm.id = ? AND ((c.type != 'private' AND c.name ${likeConc}) OR (c.type = 'private' AND (other_u.first ${likeConc} OR other_u.last ${likeConc}))) ORDER BY cm.seen DESC ${limOff}`;
	if (['events', 'pastEvents'].includes(mode)) {
		const futureOrPastWhere = mode === 'events' ? `e.type NOT LIKE 'a%' AND e.starts >= NOW()` : 'e.starts < NOW()';
		return /*sql*/ `SELECT ${eveCols}, c.city${useFullText ? `, MATCH(e.title) ${fullText} AS relevance` : ''}
		FROM events e JOIN cities c ON e.cityID = c.id
		WHERE ${futureOrPastWhere} ${useFullText ? '' : `AND e.title ${likeConc}`}
		${useFullText ? 'HAVING relevance > 0' : ''}
		ORDER BY ${useFullText ? 'relevance DESC, ' : ''}e.starts ASC ${limOff}`;
	}
	if (mode === 'users')
		return `SELECT ${usersCols} ${useFullText ? `, ${matchUser} ${fullText} AS relevance` : ''} FROM users u WHERE ${
			useFullText ? `${matchUser} ${fullText}` : `(u.first ${likeConc} OR u.last ${likeConc})`
		} ${useFullText ? 'HAVING relevance > 0' : ''} ORDER BY ${useFullText ? 'relevance DESC,' : ''} u.last ASC, u.id ASC ${limOff}`;
	if (mode === 'links')
		// INFO is not used anywhere
		return `SELECT ${usersCols} ${
			useFullText ? `, ${matchUser} ${fullText} AS relevance` : ''
		} FROM users u JOIN (SELECT user2 AS other FROM user_links WHERE user = ? AND link IN ('ok', 'tru') UNION ALL SELECT user AS other FROM user_links WHERE user2 = ? AND link IN ('ok', 'tru')) l ON u.id = l.other WHERE ${
			useFullText ? `${matchUser} ${fullText}` : `(u.first ${likeConc} OR u.last ${likeConc})`
		} ${useFullText ? 'HAVING relevance > 0' : ''} ORDER BY ${useFullText ? 'relevance DESC,' : ''} u.last ASC, u.id ASC ${limOff}`;
	if (mode === 'trusts')
		// INFO is not used anywhere
		return `SELECT ${usersCols} ${
			useFullText ? `, ${matchUser} ${fullText} AS relevance` : ''
		} FROM users u JOIN (SELECT user2 AS other FROM user_links WHERE user = ? AND link = 'tru' AND who IN (1, 3) UNION ALL SELECT user AS other FROM user_links WHERE user2 = ? AND link = 'tru' AND who IN (2, 3)) l ON u.id = l.other WHERE ${
			useFullText ? `${matchUser} ${fullText}` : `(u.first ${likeConc} OR u.last ${likeConc})`
		} ${useFullText ? 'HAVING relevance > 0' : ''} ORDER BY ${useFullText ? 'relevance DESC,' : ''} u.last ASC, u.id ASC ${limOff}`;
};

// SEARCH HANDLER --------------------------------------------------------------

// SEARCH ---
// Provides multi-entity search (users, events, chats, lists) with LIKE/FTS fallbacks.
// Normalizes offsets, builds parameterized SQL and applies privacy filters when needed.
// SEARCH HANDLER ---------------------------------------------------------------
// Steps: validate offset, build (FTS or LIKE) query + params, execute SQL, then apply redis privacy filter only for entities that require it (users/events).
async function Search(req, res) {
	const { userID, searchQ, mode, offset = 0 } = req.body;
	// VALIDATION -------------------------------------------------------------
	// Steps: parse strict integer offset so clients can’t smuggle NaN/strings, then clamp to keep the worst-case query bounded.
	const parsedOffset = parseInt(offset, 10);
	if (isNaN(parsedOffset) || parsedOffset < 0 || String(offset) !== String(parsedOffset)) return res.status(400).end();
	const numOffset = Math.min(parsedOffset, 2000);

	let con;
	try {
		// CONNECTION -----------------------------------------------------------
		// Steps: open SQL connection early; failures here are infra failures and are handled via Catcher.
		con = await Sql.getConnection();
	} catch (err) {
		logger.error('Search', { error: err, mode, userID, step: 'getConnection' });
		return Catcher({ origin: 'Search', error: err, res });
	}
	try {
		// QUERY PREP ----------------------------------------------------------
		// Steps: build bounded boolean FTS; if empty, fall back to LIKE prefix match with wildcard escaping.
		const boolFTS = buildBooleanFTS(searchQ);
		const useFullText = Boolean(boolFTS);
		const safeQ = escapeLikeWildcards(searchQ); // Escape LIKE wildcards for non-FTS queries ---------------------------

		// PARAMS --------------------------------------------------------------
		// Steps: choose param order per query template; keep the switch explicit so mode changes don’t silently break binding order.
		const params =
			mode === 'chats'
				? [userID, safeQ, safeQ, safeQ]
				: mode === 'links'
				? useFullText
					? [userID, userID, boolFTS, boolFTS]
					: [userID, userID, safeQ, safeQ]
				: mode === 'trusts'
				? useFullText
					? [userID, userID, boolFTS, boolFTS]
					: [userID, userID, safeQ, safeQ]
				: mode === 'users'
				? useFullText
					? [boolFTS, boolFTS]
					: [safeQ, safeQ]
				: useFullText
				? [boolFTS]
				: [safeQ];

		logger.info('search.query', {
			query: getQuery(mode, useFullText, numOffset),
			params,
			useFullText,
			mode,
			offset: numOffset,
			__skipRateLimit: true,
		});

		// EXECUTE & FILTER ----------------------------------------------------
		// Steps: execute query, then privacy-filter only users/events/pastEvents; other modes return raw rows.
		const [searchResults] = await con.execute(getQuery(mode, useFullText, numOffset), params);
		if (!['users', 'events', 'pastEvents'].includes(mode)) res.status(200).json(searchResults);
		else res.status(200).json(await checkRedisAccess({ items: searchResults, userID }));
	} catch (error) {
		logger.error('Search', { error, mode, userID, searchQ });
		Catcher({ origin: 'Search', error, res });
	} finally {
		// CLEANUP --------------------------------------------------------------
		// Steps: release connection on all paths so pooled connections don’t leak.
		con.release();
	}
}

export { Search };
