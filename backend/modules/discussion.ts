import { Sql, Catcher } from '../systems/systems';
import { getLogger } from '../systems/handlers/logging/index';
import { filterComments } from '../utilities/contentFilters';
import { encode } from 'cbor-x';
import { REDIS_KEYS } from '../../shared/constants';

let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Discussion uses redis for comment preview cache, stream fanout, and block filtering.
export const ioRedisSetter = r => (redis = r);
const [logger, STREAM_MAXLEN] = [getLogger('Discussion'), Number(process.env.STREAM_MAXLEN) || 50000];

// SQL EXECUTOR -----------------------------------------------------------------
// Steps: execute query and return rows only; keeps handler code focused on shaping/pagination rather than mysql2 tuple unpacking.
const executeQuery = async (con, query, params) => (await con.execute(query, params))[0];

// REDIS TRANSACTION WRAPPER ----------------------------------------------------
// Steps: run a multi() batch as a single logical mutation so comment preview + counters + stream events advance together.
const updateRedis = async ops => {
	const t = redis.multi();
	ops(t);
	await t.exec();
};

// GET COMMENTS ----------------------------------------------------------------
// Steps: short-circuit when client is synced, compute sort/pagination predicates, select ids via CTE, fetch full rows (or base placeholders), then filter blocked users before returning.
const getComments = async ({ firstID, lastID, target, selSort, cursOrOffset, devIsStable, userID, eventID, lastSync }, con) => {
	// SYNC CHECK ---
	// Steps: compare client lastSync with eveLastCommentAt so we can return empty payload when nothing changed (saves SQL work and bandwidth).
	const lastAdd = Number(await redis.hget(REDIS_KEYS.eveLastCommentAt, eventID));
	if (lastSync && lastAdd && lastAdd <= lastSync && !cursOrOffset) return { comms: [], sync: Date.now() };

	const [canOrder, hasFirst, hasLast] = [['recent', 'oldest'].includes(selSort), firstID != null, lastID != null];
	const [sort, order] = selSort === 'popular' ? ['score', 'DESC'] : selSort === 'replies' ? ['replies', 'DESC'] : ['c.created', selSort === 'oldest' ? 'ASC' : 'DESC'];

	// PAGINATION LOGIC ---
	// Steps: translate firstID/lastID into a stable predicate so client can page by ids without exposing fragile offsets.
	let [pred, baseParams] = ['0', []];
	if (hasFirst && !hasLast) {
		pred = 'c.id = ?';
		baseParams.push(firstID);
	} else if (hasFirst && hasLast) {
		pred = 'c.id BETWEEN LEAST(?, ?) AND GREATEST(?, ?)';
		baseParams.push(firstID, lastID, firstID, lastID);
	} else if (!hasFirst && hasLast) {
		pred = `c.id ${selSort === 'recent' ? '<=' : '>='} ?`;
		baseParams.push(lastID);
	}

	const curCond = canOrder && cursOrOffset ? `AND c.id ${selSort === 'recent' ? '<' : '>'} ?` : '';
	const limit = `LIMIT 20${!canOrder ? ` OFFSET ${Math.min(Number(cursOrOffset) || 0, 10000)}` : ''}`;
	const orderBy = `ORDER BY ${sort} ${order}`;

	// QUERY CONSTRUCTION ---
	// Steps: CTE selects ids + row_number position, then we either fetch FULL directly (fresh load) or union BASE placeholders with FULL for non-base rows (delta load).
	const CTE = `WITH Selected AS (SELECT c.id${hasFirst || hasLast ? `, (${pred}) AS isBase` : ''}, ROW_NUMBER() OVER (${orderBy}) AS pos FROM comments c WHERE c.event = ? ${
		target ? 'AND c.target = ?' : 'AND c.target IS NULL'
	} ${curCond} ${orderBy} ${limit})`;
	const ratingJoin = !devIsStable ? 'LEFT JOIN comm_rating r ON c.id = r.comment AND r.user = ?' : '';
	const ratingCols = !devIsStable ? ', NULL AS mark, NULL AS awards' : '';
	const ratingColsFull = !devIsStable ? ', r.mark, r.awards' : '';
	// BASE: skeleton row for already-loaded comments (isBase = 1)
	const BASE = `SELECT s.id, NULL AS user, c.replies, c.score, c.flag, NULL AS content, NULL AS created, NULL AS first, NULL AS last, NULL AS imgVers${ratingCols}, s.pos FROM Selected s JOIN comments c ON c.id = s.id WHERE s.isBase = 1`;
	// FULL: complete row with user info and content; baseFilter adds WHERE clause for UNION context
	const fullSelect = `SELECT s.id, c.user, c.replies, c.score, c.flag, CASE WHEN c.flag != 'del' THEN c.content ELSE NULL END AS content, c.created, u.first, u.last, u.imgVers${ratingColsFull}, s.pos FROM Selected s JOIN comments c ON c.id = s.id JOIN users u ON c.user = u.id ${ratingJoin}`;
	const FULL = baseFilter => `${fullSelect}${baseFilter ? ' WHERE s.isBase = 0' : ''}`;

	const qParams = [eventID, ...(target ? [target] : []), ...(canOrder && cursOrOffset ? [cursOrOffset] : [])];
	// QUERY ASSEMBLY ---
	// Fresh load: use FULL directly; delta load: UNION BASE (skeleton) with FULL filtered to non-base rows
	const query = !hasFirst && !hasLast ? `${CTE} ${FULL(false)} ORDER BY s.pos` : `${CTE} SELECT * FROM (${BASE} UNION ALL ${FULL(true)}) x ORDER BY pos`;

	// EXECUTE + FILTER --------------------------------------------------------
	// Steps: execute once, then apply block filtering using redis blocks set so client never sees comments from blocked users.
	const comms = await executeQuery(con, query, [...(hasFirst || hasLast ? baseParams : []), ...qParams, ...(!devIsStable ? [userID] : [])]);
	return { comms: filterComments({ items: comms, blocks: new Set(await redis.smembers(`${REDIS_KEYS.blocks}:${userID}`)) }), sync: !cursOrOffset ? Date.now() : null };
};

// POST COMMENT ----------------------------------------------------------------
// Steps: insert row in SQL, then update redis preview cache + per-event counters, then append a delta event into eveComments stream for async fanout.
const postComment = async ({ eventID, userID, content, target = null, attach = null }, con) => {
	const res = await executeQuery(con, `INSERT INTO comments (user, event, target, content, attach, created) VALUES (?, ?, ?, ?, ?, NOW())`, [userID, eventID, target, content, attach]);
	const id = res?.insertId;

	await updateRedis(t => {
		t.hset('commentAuthorContent', id, encode([userID, (content || '').slice(0, 40)]));
		t.hincrby('newEveCommsCounts', eventID, 1);
		t.xadd('eveComments', 'MAXLEN', '~', STREAM_MAXLEN, '*', 'payload', encode(['delta', eventID, target || 0, 1, target ? 1 : 0, id]));
	});
	return id;
};

// EDIT COMMENT ----------------------------------------------------------------
// Steps: update SQL only for owning user, then rewrite redis preview cache so downstream alert/task processors have fresh content snippet.
const editComment = async ({ content = null, attach = null, id, userID }, con) => {
	const res = await executeQuery(con, `UPDATE comments SET content = IFNULL(?, content), attach = IFNULL(?, attach) WHERE id = ? AND user = ?`, [content, attach, id, userID]);
	if (!res?.affectedRows) return 'denied';
	await redis.hset(REDIS_KEYS.commentAuthorContent, id, encode([userID, (content || '').slice(0, 40)]));
	return 'edited';
};

// DELETE COMMENT --------------------------------------------------------------
// Steps: verify ownership and load (event,target), delete SQL row, then remove preview cache and emit a delta event so counters/alerts can be recomputed downstream.
const deleteComment = async ({ id, userID }, con) => {
	const [row] = await executeQuery(con, `SELECT event, target FROM comments WHERE id = ? AND user = ?`, [id, userID]);
	if (!row) return 'denied';

	await executeQuery(con, `DELETE FROM comments WHERE id = ? AND user = ?`, [id, userID]);
	await updateRedis(t => {
		t.hdel('commentAuthorContent', id);
		t.xadd('eveComments', 'MAXLEN', '~', STREAM_MAXLEN, '*', 'payload', encode(['delta', row.event, row.target || 0, row.target ? 0 : -1, row.target ? -1 : 0, id]));
	});
	return 'deleted';
};

// GET REPLIES -----------------------------------------------------------------
// Steps: enforce target presence, then reuse getComments so reply pagination and filtering stays consistent.
const getReplies = async (p, con) => {
	if (!p.target) throw new Error('badRequest');
	return getComments(p, con);
};

const handlers = { post: postComment, getComments, getReplies, edit: editComment, delete: deleteComment };

// MAIN ROUTER -----------------------------------------------------------------

/** ----------------------------------------------------------------------------
 * DISCUSSION DISPATCHER
 * Delegates requests to specific handlers based on 'mode'.
 * Handles DB connection management and error catching.
 * -------------------------------------------------------------------------- */
export const Discussion = async (req, res) => {
	let con;
	try {
		const { mode } = req.body;
		// MODE ROUTING ---------------------------------------------------------
		// Steps: reject unknown mode early, then run handler under one SQL connection so multi-query operations share the same session.
		if (!handlers[mode]) return res.status(400).json({ error: 'invalidMode' });
		con = await Sql.getConnection();
		res.status(200).json((await handlers[mode](req.body, con)) ?? null);
	} catch (e) {
		logger.error('Discussion', { error: e, ...req.body });
		Catcher({ origin: 'Discussion', error: e, res });
	} finally {
		// CLEANUP --------------------------------------------------------------
		// Steps: release connection even on handler error so pool stays healthy.
		con?.release();
	}
};
