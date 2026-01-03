import { Sql, Catcher, Socket } from '../systems/systems';
import { calculateAge, delFalsy } from '../../shared/utilities';
import { encode, decode } from 'cbor-x';
import { USER_GENERIC_KEYS, USER_PROFILE_KEYS, REDIS_KEYS } from '../../shared/constants';
import { emitToUsers } from '../systems/socket/socket';
import { fetchUserData } from '../systems/handlers/emitter';
import { getLogger } from '../systems/handlers/logging/index';
import { LRUCache } from 'lru-cache';

let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// User module needs redis for blocks/links/trusts sets and profile cache buckets.
export const ioRedisSetter = r => (redis = r);
const logger = getLogger('User');

// LOCAL CACHE -----------------------------------------------------------------
// Steps: cache small “basic profile” hashes in-process so hot profiles don’t repeatedly hit redis for the same fields.
const userCache = new LRUCache({
	max: 2000, // Keep 2000 active user profiles
	ttl: 5 * 60 * 1000, // 5 minutes
	updateAgeOnGet: false,
});

// INVALIDATE CACHE -----------------------------------------------------------
// Steps: clear local cache entry so next profile read falls back to redis/SQL and sees updated names/images.
export const invalidateUserCache = userID => userCache.delete(userID);

// SQL QUERIES ------------------------------------------------------------------
// Centralizes templates for link/trust/block mutations to keep handler logic readable.
const qs = {
	note: `UPDATE user_links SET note = CASE WHEN ?=1 THEN ? ELSE note END, note2 = CASE WHEN ?=2 THEN ? ELSE note2 END WHERE user = ? AND user2 = ?`,
	link: `INSERT INTO user_links (user, user2, note, note2, who, message, link, changed) VALUES (?, ?, CASE WHEN ?=1 THEN ? ELSE NULL END, CASE WHEN ?=2 THEN ? ELSE NULL END, ?, ?, 'req', NOW()) ON DUPLICATE KEY UPDATE link = CASE WHEN (link='del' OR (link='ref' AND who!=VALUES(who))) THEN 'req' ELSE link END, who = CASE WHEN (link='del' OR (link='ref' AND who!=VALUES(who)) OR (link='req' AND who!=VALUES(who))) THEN VALUES(who) ELSE who END, message = CASE WHEN (link IN ('del','req') OR (link='ref' AND who!=VALUES(who))) THEN VALUES(message) ELSE message END, note = CASE WHEN (link IN ('del','req') OR (link='ref' AND who!=VALUES(who))) AND VALUES(who)=1 THEN VALUES(note) ELSE note END, note2 = CASE WHEN (link IN ('del','req') OR (link='ref' AND who!=VALUES(who))) AND VALUES(who)=2 THEN VALUES(note2) ELSE note2 END, changed = CASE WHEN (link IN ('del','req') OR (link='ref' AND who!=VALUES(who))) THEN NOW() ELSE changed END`,
	cancel: `DELETE FROM user_links WHERE user=? AND user2=? AND link='req'`,
	accept: `UPDATE user_links SET link='ok', message=NULL, who=NULL, changed=NOW(), created=NOW(), note2=? WHERE user=? AND user2=? AND (link='req' OR (link='ref' AND who!=?))`,
	refuse: `UPDATE user_links SET link='ref', message=NULL WHERE user=? AND user2=? AND who=? AND link='req'`,
	unlink: `UPDATE user_links SET link='del', note=NULL, note2=NULL WHERE user=? AND user2=? AND link IN ('ok','tru')`,
	block: `INSERT INTO user_blocks (user, user2, who) VALUES (?, ?, ?)`,
	unblock: `DELETE FROM user_blocks WHERE user=? AND user2=? AND who=?`,
};

// REDIS MUTATION HELPER --------------------------------------------------------
// Steps: mutate link/trust sets, then bump summary watermarks so other devices know they must resync relationship state.
const updateRedis = async (m, u, i) => {
	const t = redis.multi(),
		ts = Date.now();
	if (['accept', 'unlink'].includes(m)) [u, i].map(x => t.hset(`userSummary:${x}`, 'user_links', ts));
	if (['unlink', 'block'].includes(m)) {
		t.srem(`links:${u}`, i).srem(`links:${i}`, u).srem(`trusts:${u}`, i).srem(`trusts:${i}`, u);
		t.hset(`${REDIS_KEYS.userSetsLastChange}:${u}`, 'links', ts).hset(`${REDIS_KEYS.userSetsLastChange}:${i}`, 'links', ts);
	} else {
		['trust', 'untrust'].includes(m)
			? t[m === 'trust' ? 'sadd' : 'srem'](`trusts:${u}`, i)
			: t.sadd(`links:${u}`, i).sadd(`links:${i}`, u).hset(`${REDIS_KEYS.userSetsLastChange}:${u}`, 'links', ts).hset(`${REDIS_KEYS.userSetsLastChange}:${i}`, 'links', ts);
	}
	await t.exec();
};

// GET PROFILE ------------------------------------------------------------------
// - own profile (including util cols) when id is not provided
// - other user's profile (cached) when id is provided
// Steps: own profile reads from SQL (full shape), other profile reads from redis (basiOnly) or redis->SQL->redis cache (full), then overlays rating for unstable devices.
export async function getProfile({ userID, id, basiOnly, devIsStable }, con) {
	// If no ID, fetch own profile (includes util columns)
	if (!id) {
		const [[user]] = await con.execute(`SELECT ${USER_PROFILE_KEYS.map(col => `u.${col}`).join(', ')} FROM users u WHERE id = ?`, [userID]);
		if (!user) throw new Error('notFound');
		user.age = calculateAge(user.birth);
		return delFalsy(user);
	}
	if (await redis.sismember(`blocks:${userID}`, id)) throw new Error('blocked');

	// TARGET PROFILE FETCH ---------------------------------------------------
	// Steps: basiOnly prefers local cache then redis hash; full profile prefers redis buffer cache and falls back to SQL only on miss.
	let cachedBasi;
	if (basiOnly) cachedBasi = userCache.get(id);

	const [p, [[{ mark, awards } = {}]]] = await Promise.all([
		basiOnly
			? cachedBasi || redis.hgetall(`userBasics:${id}`).then(res => (userCache.set(id, res), res))
			: redis.getBuffer(`tempProfile:${id}`).then(async b => {
					if (b) return decode(b);
					let c;
					try {
						c = await Sql.getConnection();
						const [[u]] = await c.execute(`SELECT ${USER_GENERIC_KEYS.map(col => `u.${col}`).join(', ')} FROM users u WHERE id=?`, [id]);
						if (!u) throw new Error((await redis.hexists(`remUse`, id)) ? 'deleted' : 'notFound');
						return (u.age = calculateAge(u.birth)), delete u.birth, delFalsy(u), redis.setex(`tempProfile:${id}`, 604800, encode(u)), u;
					} finally {
						c?.release();
					}
			  }),
		!devIsStable && con ? con.execute(`SELECT mark, awards FROM user_rating WHERE user=? AND user2=?`, [userID, id]) : [[{}]],
	]);
	// OVERLAY RATING ---------------------------------------------------------
	// Steps: attach mark/awards only when mark exists so payload stays compact.
	return mark ? { ...p, mark, awards } : p;
}

// LINKS HANDLER ----------------------------------------------------------------
// Steps: validate payload, perform SQL mutation (some modes in a transaction), update redis sets + watermarks, write alerts when needed, then emit sockets so online clients converge.
const linksHandler = async ({ mode, userID, id, note, message }, con) => {
	// VALIDATION -------------------------------------------------------------
	// Steps: bound message/note size; enforce daily request cap via redis so DB isn’t used as a rate limiter.
	if (message?.length > 200 || note?.length > 200 || (mode === 'link' && (await redis.hincrby('dailyLinkReqCounts', userID, 1)) > 40))
		throw new Error(mode === 'link' ? 'tooManyLinkRequest' : 'badRequest');
	const ord = [userID, id].sort(),
		who = ord[0] === userID ? 1 : 2;

	try {
		// SQL MUTATION ---------------------------------------------------------
		// Steps: start transaction for accept/refuse so alert flag updates are atomic with link state changes.
		if (['refuse', 'accept'].includes(mode)) await con.beginTransaction();
		if (mode === 'link' && (await redis.sismember(`links:${userID}`, id))) throw new Error('alreadyLinked');

		const args = { note: [who, note, who, note, ...ord], link: [...ord, who, note, who, note, who, message], accept: [note, ...ord, who], unlink: [...ord] }[mode] || [...ord, who === 1 ? 2 : 1];
		const [res] = await con.execute(qs[mode], args);
		if (!res.affectedRows) throw new Error('noUpdate');

		// ALERT FLAG UPDATES ---------------------------------------------------
		// Steps: for accept/refuse, update user_alerts flag and commit so client-visible alert state matches link state.
		if (['refuse', 'accept'].includes(mode))
			await con.execute('UPDATE user_alerts SET flag=? WHERE user=? AND target=? AND what=?', [mode === 'accept' ? 'acc' : 'ref', userID, id, 'link']), await con.commit();

		// REDIS WATERMARKS + ALERT INSERT -------------------------------------
		// Steps: bump userSummary watermarks so other devices know to resync, update relationship sets, then optionally insert a user_alerts row for link/accept.
		const t = redis.multi(),
			ts = Date.now();
		if (mode !== 'note') t.hset(`userSummary:${userID}`, 'user_links', ts);
		if (!['trust', 'untrust', 'note'].includes(mode)) t.hset(`userSummary:${id}`, 'user_links', ts);

		if (['accept', 'unlink', 'trust', 'untrust'].includes(mode)) await updateRedis(mode, userID, id);
		if (['accept', 'link'].includes(mode))
			await con.execute(`INSERT INTO user_alerts (user, what, target, data) VALUES (?, ?, ?, ?)`, [
				id,
				mode,
				userID,
				JSON.stringify({ ...(await fetchUserData([userID, id], redis, con))[userID], ...(message && { message }) }),
			]);

		// EMIT ---------------------------------------------------------------
		// Steps: exec redis mutations, then emit to users unless mode is refuse (refuse is silent to the other party).
		await Promise.all([t.exec(), ...(mode === 'refuse' ? [] : [emitToUsers({ mode, userID, otherUserID: id, note, message })])]);
	} catch (e) {
		if (['refuse', 'accept'].includes(mode)) await con.rollback();
		logger.error('linksHandler', { error: e, userID, id, mode });
		throw new Error('userLinkUpdateFailed');
	}
};

// TRUSTS HANDLER --------------------------------------------------------------
// Steps: update link state to/from tru in SQL under a transaction, emit to socket immediately, then update redis sets/watermarks so other devices converge.
const trustsHandler = async ({ mode, userID, id }, con) => {
	const ord = [userID, id].sort(),
		who = ord[0] === userID ? 1 : 2,
		opp = who === 1 ? 2 : 1;
	try {
		await con.beginTransaction();
		const q =
			mode === 'trust'
				? `UPDATE user_links SET link='tru', who=CASE WHEN who=? THEN 3 ELSE ? END WHERE user=? AND user2=? AND link IN ('ok','tru')`
				: `UPDATE user_links SET link=CASE WHEN who=? THEN 'ok' ELSE link END, who=CASE WHEN who=3 THEN ? ELSE NULL END WHERE user=? AND user2=? AND link IN ('tru','ok')`;
		if (!(await con.execute(q, mode === 'trust' ? [opp, who, ...ord] : [who, opp, ...ord]))[0].affectedRows) throw new Error('noUpdate');
		(await (Socket as any)()).to(userID).emit(mode, { target: id });
		await con.commit();
		await updateRedis(mode, userID, id);
		await redis.multi().hset(`${REDIS_KEYS.userSetsLastChange}:${userID}`, 'trusts', Date.now()).hset(`${REDIS_KEYS.userSetsLastChange}:${id}`, 'trusts', Date.now()).exec();
	} catch (e) {
		await con.rollback();
		logger.error('trustsHandler', { error: e, userID, id, mode });
		throw new Error('userTrustsUpdateFailed');
	}
};

// BLOCKS HANDLER ---------------------------------------------------------------
// Steps: write user_blocks row, unlink relationship when blocking, then update symmetric redis block sets + watermarks and emit to sockets so clients remove hidden content.
const blocksHandler = async ({ mode, userID, id }, con) => {
	const ord = [userID, id].sort(),
		who = ord[0] === userID ? 1 : 2;
	try {
		const [[b], [l]] = await Promise.all([con.execute(qs[mode], [userID, id, who]), mode === 'block' ? con.execute(`UPDATE user_links SET link='del' WHERE user=? AND user2=?`, ord) : [{}]]);
		if (l?.affectedRows) await updateRedis(mode, userID, id);
		if (mode !== 'unblock' || b.affectedRows)
			await Promise.all([
				redis
					.multi()[mode === 'block' ? 'sadd' : 'srem'](`blocks:${userID}`, id)[mode === 'block' ? 'sadd' : 'srem'](`blocks:${id}`, userID)
					.hset(`${REDIS_KEYS.userSetsLastChange}:${userID}`, 'blocks', Date.now())
					.hset(`${REDIS_KEYS.userSetsLastChange}:${id}`, 'blocks', Date.now())
					.exec(),
				emitToUsers({ mode, userID, otherUserID: id }),
			]);
	} catch (e) {
		logger.error('blocksHandler', { error: e, userID, id, mode });
		throw new Error('userBlockUpdateFailed');
	}
};

const handlers = {
	link: linksHandler,
	note: linksHandler,
	accept: linksHandler,
	refuse: linksHandler,
	cancel: linksHandler,
	unlink: linksHandler,
	block: blocksHandler,
	unblock: blocksHandler,
	profile: getProfile,
	trust: trustsHandler,
	untrust: trustsHandler,
};

// MAIN ROUTER HANDLER ---------------------------------------------------------
// Steps: choose whether SQL connection is needed, dispatch by mode, then return payload (or empty) while routing errors through Catcher.
export async function User(req, res) {
	let con;
	try {
		// CONNECTION POLICY ----------------------------------------------------
		// Steps: profile reads may skip SQL when basiOnly+stable+id are present; all other modes need SQL.
		con = req.body.mode !== 'profile' || !req.body.devIsStable || !req.body.id ? await Sql.getConnection() : null;
		const payload = await handlers[req.body.mode](req.body, con);
		res.status(200)[payload ? 'json' : 'end'](payload);
	} catch (e) {
		if (e.code === 'ER_DUP_ENTRY') throw new Error('duplicateEntry');
		if (e.message === 'noUpdate') return res.status(200).end();
		Catcher({ origin: 'User', error: e, res });
	} finally {
		// CLEANUP --------------------------------------------------------------
		// Steps: release connection when it was acquired.
		con?.release();
	}
}
