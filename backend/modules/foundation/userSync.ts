// USER DATA SYNC ----------------------------------------------------------------
import { delFalsy } from '../../../shared/utilities';
import { getOrCacheFilteringSets } from '../../utilities/helpers/cache';
import { getProfile } from '../user';
import { updateLoginsTable } from '../entrance/index';
import { Sql } from '../../systems/systems';
import { getLogger } from '../../systems/handlers/logging/index';
import { REDIS_KEYS } from '../../../shared/constants';
import { userSummaryKey, redis } from './utils';

const logger = getLogger('FoundationUserSync');

// CONFIGURATION -----------------------------------------------------------------
// Maps table names to their column requirements and response array keys
// DELTA SYNC CONFIG -------------------------------------------------------------
// Defines which tables are tracked and how their row shapes map to frontend payload arrays.
const minInterval = 30000; // 30s throttle
const configs = {
	user_links: { cols: ' user, user2, who, link', arrName: 'linkUsers' },
	user_rating: { cols: 'user2, mark, awards', arrName: 'rateUsers', targetCol: 'user2' },
	comm_rating: { cols: 'comment, mark, awards', arrName: 'rateComm', targetCol: 'comment' },
	eve_rating: { cols: 'event, mark, awards', arrName: 'rateEve', targetCol: 'event' },
	eve_inters: { cols: 'event, inter, priv', arrName: 'eveInters' },
};
const tableNames = Object.keys(configs);

// EXECUTE DELTA QUERY -----------------------------------------------------------
// Generic processor for fetching table changes (sync) or full state (init)
// EXECUTE TABLE DELTA -----------------------------------------------------------
// Steps: choose query by table + sync mode, read rows, partition into add/del payloads, then attach them under stable frontend keys (interactions/delInteractions).
async function execQuery({ table, userID, sync, interactions, delInteractions, con }) {
	try {
		const [isLinks, { cols, arrName, targetCol }] = [table === 'user_links', configs[table]];

		// QUERY BUILD -----------------------------------------------------------
		// Steps: when sync=0 do full snapshot for that table; when sync>0 do changed-since to minimize rows and keep client convergence fast.
		const query = `SELECT ${cols} FROM ${table} WHERE ${isLinks ? '(user = ? OR user2 = ?)' : 'user = ?'} ${
			!sync
				? table.includes('rating')
					? 'AND mark > 0'
					: `AND ${{ eve_inters: 'inter', user_links: 'link', users: 'flag' }[table]} != "del" ${table === 'user_links' ? 'AND link NOT IN ("req", "ref")' : ''}`
				: `AND changed >= FROM_UNIXTIME(?) ${isLinks ? 'AND link NOT IN ("req", "ref")' : ''}`
		}`;
		const params = [userID, ...(isLinks ? [userID] : []), ...(sync ? [Math.floor(sync / 1000)] : [])];

		const [res] = await con.execute(query, params);

		// PARTITION RESULTS -----------------------------------------------------
		// Steps: convert SQL row shapes into compact client arrays; treat “del” markers / mark=0 as deletes so UI can remove without full refetch.
		let add: any = arrName === 'eveInters' ? { sur: [], may: [], int: [] } : [];
		let del: any[] = [];

		if (arrName === 'eveInters') {
			// Event Interactions: Split by interest level (Surely, Maybe, Interested)
			for (const { event, inter, priv } of res) inter === 'del' ? del.push(event) : add[inter].push([event, priv]);
		} else if (arrName.startsWith('rate')) {
			// Ratings: standard item/mark pairs
			for (const item of res) !item.mark ? del.push(item[targetCol]) : add.push([item[targetCol], item.mark, ...(item.awards ? [item.awards] : [])]);
		} else {
			// User Links: Handle bidirectional relationships and "Trusts" flags
			for (const { user, user2, link, who } of res) {
				const [userWho, otherUser] = userID == user ? [1, user2] : [2, user];
				link === 'del' ? del.push(otherUser) : add.push([otherUser, ...(link === 'tru' && [userWho, 3].includes(who) ? ['tru'] : [])]);
			}
		}

		(interactions[arrName] = add), (delInteractions[arrName] = del);
	} catch (error) {
		logger.error('execQuery', { error, table, userID });
	}
}

// SYNC HANDLER ------------------------------------------------------------------
// Orchestrates the check-fetch-update cycle for user data tables
// SYNC USER DATA ---------------------------------------------------------------
// Steps: update login stats (init), read redis summary watermarks, decide which tables need fetch (full vs delta), run minimal SQL reads, then persist missing summary timestamps.
async function syncUserData(req, con, { userID, load, devID, devSync, linksSync, oldUserUnstableDev }) {
	let user: any = null, interactions: any = {}, delInteractions: any = {};
	const [tablesToFetch, hasNoTimestamp, now] = [[], [], Date.now()];
	const summaryKey = userSummaryKey(userID);

	// 1. UPDATE LOGIN STATS (Non-blocking) -----------------------------------
	// Steps: fire-and-forget so init doesn’t stall on analytics bookkeeping.
	if (load === 'init') {
		if (!con) con = await Sql.getConnection();
		updateLoginsTable(req, userID, con).catch(e => logger.error('foundation.login_track_fail', { error: e }));
	}

	// 2. CHECK REDIS SUMMARIES FOR CHANGES -----------------------------------
	// Steps: fetch summary watermarks unless device is unstable (unstable devices follow a safer fallback path).
	let [lastDevSummary, linksChangeSummary] = [null, null];
	if (!oldUserUnstableDev) {
		try {
			[lastDevSummary, linksChangeSummary] = await redis.hmget(summaryKey, 'last_dev', 'user_links');
		} catch (error) {
			logger.error('Foundation', { error, userID, step: 'readSummary' });
		}
	}

	// 3. DETERMINE TABLES TO FETCH -------------------------------------------
	// Steps: choose between (a) unstable-device fallback, (b) full snapshot for devSync=0, (c) throttled delta reads when enough time has passed.
	if (oldUserUnstableDev) {
		// UNSTABLE DEVICE PATH -------------------------------------------------
		// Steps: if linksSync is missing, reconstruct from redis sets/SQL cache; otherwise only fetch links deltas when summary indicates changes.
		if (!linksSync) {
			// LINKS REBUILD ------------------------------------------------------
			// Steps: prefer redis sets, otherwise repopulate from SQL via getOrCacheFilteringSets so future requests are cheap.
			const [linksSet, trustsSet] = await Promise.all([getOrCacheFilteringSets(con, REDIS_KEYS.links as any, userID), getOrCacheFilteringSets(con, REDIS_KEYS.trusts as any, userID)]);

			interactions.linkUsers = [...linksSet].map(id => [id, ...(trustsSet.has(id) ? ['tru'] : [])]);
			linksSync = now;
			// FORCE OTHER TABLE RESYNC ------------------------------------------
			// Steps: clear last_dev so next pass treats device as needing broader convergence.
			await redis.hdel(summaryKey, 'last_dev');
		} else {
			// LINKS DELTA CHECK --------------------------------------------------
			// Steps: fetch links only when summary indicates changes since client watermark.
			const linksChange = await redis.hget(summaryKey, 'user_links');
			if (!linksChange || linksChange > linksSync) tablesToFetch.push('user_links'), !linksChange && hasNoTimestamp.push('user_links');
		}
	} else if (!devSync) {
		// CLEAN STATE FULL SNAPSHOT -------------------------------------------
		// Steps: first-time device fetch pulls all tracked tables so client can bootstrap without deltas.
		tablesToFetch.push(...tableNames);
	} else if (now - devSync > minInterval) {
		// THROTTLED DELTA UPDATE ----------------------------------------------
		// Steps: only do delta reads when minInterval passed; avoids hammering SQL during rapid client polling.
		try {
			// LINKS CHECK --------------------------------------------------------
			// Steps: links are checked against summary and use devSync as default watermark when linksSync isn’t separate.
			if (!linksChangeSummary || linksChangeSummary > devSync) tablesToFetch.push('user_links'), !linksChangeSummary && hasNoTimestamp.push('user_links');
			// CROSS-DEVICE UPDATE CHECK -----------------------------------------
			// Steps: when last_dev differs, another device likely wrote changes; fetch only tables whose summary timestamp exceeds devSync.
			if (lastDevSummary !== devID) {
				if (devID) await redis.hset(summaryKey, 'last_dev', devID);
				const ownInteractionTables = tableNames.filter(t => t !== 'user_links');
				const summaryValues = await redis.hmget(summaryKey, ...ownInteractionTables);
				for (const [idx, value] of summaryValues.entries())
					if (!value || value > devSync) tablesToFetch.push(ownInteractionTables[idx]), !value && hasNoTimestamp.push(ownInteractionTables[idx]);
			}
		} catch (error) {
			logger.error('Foundation', { error, userID, step: 'checkForUpdates' });
		}
	}

	// 4. EXECUTE SQL FETCHES -------------------------------------------------
	// Steps: open a connection once, then run per-table execQuery in parallel; update the correct watermark (linksSync vs devSync) based on which path executed.
	if (tablesToFetch.length > 0) {
		try {
			if (!con) con = await Sql.getConnection();
			// PROFILE FETCH ------------------------------------------------------
			// Steps: fetch profile only when explicitly included; most deltas avoid the user profile read.
			if (tablesToFetch.includes('users')) user = await getProfile({ userID, id: userID, basiOnly: false, devIsStable: true }, con);

			const syncStart = Date.now();
			await Promise.all(
				tablesToFetch.filter(table => table !== 'users').map(table => execQuery({ table, userID, sync: linksSync || devSync, con, interactions, delInteractions }))
			);

			// WATERMARK ADVANCE --------------------------------------------------
			// Steps: advance the relevant watermark to the start of this sync; client can request changes strictly after this point next time.
			linksSync ? (linksSync = syncStart) : (devSync = syncStart);
			interactions = delFalsy(interactions, false, false, false, true);
			delInteractions = delFalsy(delInteractions);
		} catch (error) {
			logger.error('Foundation', { error, userID, step: 'fetchTables', tables: tablesToFetch });
		}
	}

	// 5. UPDATE MISSING TIMESTAMPS -------------------------------------------
	// Steps: when a summary field was missing, set it now so future comparisons can be purely numeric and cheap.
	if (hasNoTimestamp.length > 0) {
		try {
			await redis.hset(summaryKey, ...hasNoTimestamp.map(table => [table, now]).flat());
		} catch (error) {
			logger.error('Foundation', { error, userID, step: 'updateTimestamps' });
		}
	}

	return { user, interactions, delInteractions, devSync, linksSync };
}

export { syncUserData };

