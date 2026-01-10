import { Sql, Catcher } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { checkRedisAccess } from '../utilities/contentFilters';
import { USER_MINI_KEYS } from '../../shared/constants.ts';

interface GalleryRequest {
	userID: string | number;
	devIsStable?: boolean;
	mode: 'blocks' | 'invitesIn' | 'invitesOut' | 'links' | 'requests' | 'trusts' | 'pastEvents' | 'events' | 'deletePast' | string;
	sort?: string;
	offset?: number | string;
	eventID?: number | string;
}

// GALLERY MODULE ---------------------------------------------------------------
// Provides paginated "lists" for the frontend (events, links, blocks, invites, etc.).
// Uses mode-specific SQL builders and applies privacy filtering for event lists.

const eveCols =
	['id', 'title', 'place', 'location', 'starts', 'ends', 'surely', 'maybe', 'owner', 'priv', 'type', 'imgVers', 'flag', 'score'].map(c => `e.${c}`).join(', ') +
	',ST_X(e.coords) lat,ST_Y(e.coords) lng';
const PAGE = 20;

const sortMaps: Record<string, Record<string, string>> = {
	links: {
		recent: 'created DESC',
		oldest: 'created',
		first: 'first',
		last: 'last',
		incoming: 'CASE WHEN tab.user=? THEN tab.user2 ELSE tab.user END',
		outgoing: 'CASE WHEN tab.user=? THEN tab.user ELSE tab.user2 END',
	},
	events: { earliest: 'e.starts,e.id', latest: 'e.starts DESC,e.id DESC', score: '(3*e.surely+e.maybe+0.2*e.score) DESC,e.id DESC', recent: 'e.starts DESC,e.id DESC', oldest: 'e.starts,e.id' },
	created: { recent: 'created DESC', oldest: 'created' },
};

// SUBQUERIES ------------------------------------------------------------------

const blocksQ = `SELECT ${USER_MINI_KEYS.map(c => `u.${c}`).join(', ')},tab.created FROM users u JOIN user_blocks tab ON((tab.user=? AND tab.user2=u.id) OR(tab.user2=? AND tab.user=u.id))`;
const invitesAggQ = (dir: 'in' | 'out') => {
	const isIn = dir === 'in',
		where = isIn ? 'ei.user2=? AND ei.flag NOT IN("del","ref")' : 'ei.user=?';
	return `WITH RankedInvites AS(SELECT ei.event,ei.created,ei.flag,u.id,u.first,u.last,u.imgVers,ROW_NUMBER()OVER(PARTITION BY ei.event ORDER BY ei.created DESC) rn FROM users u JOIN eve_invites ei ON u.id=${
		isIn ? 'ei.user' : 'ei.user2'
	} WHERE ${where}) SELECT ${eveCols},c.city,MAX(ei.created) created,COUNT(*) ${
		isIn ? 'invitesInTotal' : 'invitesOutTotal'
	},(SELECT JSON_ARRAYAGG(JSON_OBJECT('id',ri2.id,'first',ri2.first,'last',ri2.last,'imgVers',ri2.imgVers,'created',ri2.created,'flag',ri2.flag)) FROM RankedInvites ri2 WHERE ri2.event=e.id AND ri2.rn<=3 AND ri2.id IS NOT NULL) invites FROM events e JOIN eve_invites ei ON ei.event=e.id JOIN cities c ON e.cityID=c.id LEFT JOIN RankedInvites ri ON ri.event=e.id AND ri.rn<=3 WHERE ${where} GROUP BY e.id`;
};

// QUERY BUILDER ---------------------------------------------------------------
// Steps: map mode into a query template + order clause; keep this centralized so handler stays a thin orchestration layer.
const buildQuery = ({ mode, sort, devIsStable }: { mode: string; sort: string; devIsStable?: boolean }): { sql: string; order: string; orderNeedsUser?: boolean } => {
	if (mode === 'blocks') return { sql: blocksQ, order: `tab.${sortMaps.created[sort] || sortMaps.created.recent}` };
	if (mode === 'invitesIn') return { sql: invitesAggQ('in'), order: sortMaps.created[sort] || sortMaps.created.recent };
	if (mode === 'invitesOut') return { sql: invitesAggQ('out'), order: sortMaps.created[sort] || sortMaps.created.recent };
	if (['links', 'requests', 'trusts'].includes(mode)) {
		const sql = `WITH cte AS(SELECT tab.created,${
			mode === 'requests' ? 'CASE WHEN(tab.user=? AND who="2") OR(tab.user2=? AND who="1") THEN tab.message ELSE NULL END message,' : ''
		}CASE WHEN tab.user=? THEN tab.user2 ELSE tab.user END other_user,tab.who,CASE WHEN(tab.user=?) THEN tab.note WHEN(tab.user2=?) THEN tab.note2 ELSE NULL END note FROM user_links tab WHERE(tab.user=? OR tab.user2=?) AND ${
			mode === 'links'
				? 'tab.link IN("ok","tru")'
				: mode === 'requests'
				? '((tab.link="req") OR (tab.link="ref" AND ((tab.user=? AND tab.who=1) OR (tab.user2=? AND tab.who=2))))'
				: 'tab.link="tru"'
		}${mode === 'trusts' ? ` AND ((tab.user=? AND tab.who IN(1,3)) OR (tab.user2=? AND tab.who IN(2,3)))` : ''}) SELECT ${USER_MINI_KEYS.map(c => `u.${c}`).join(
			', '
		)},cte.created,cte.note,cte.who${mode === 'requests' ? ',cte.message' : ''} FROM users u JOIN cte ON u.id=cte.other_user`;
		return { sql, order: sortMaps.links[sort] || sortMaps.created.recent, orderNeedsUser: ['incoming', 'outgoing'].includes(sort) };
	}
	const isPast = mode.startsWith('past');
	const needsInters = !devIsStable || isPast || mode.includes('SurMay') || mode.includes('Int');
	const base = `SELECT ${eveCols},${needsInters ? 'ei.inter,ei.priv interPriv,' : ''}c.city FROM events e LEFT JOIN cities c ON e.cityID=c.id ${
		needsInters ? 'LEFT JOIN eve_inters ei ON e.id=ei.event AND ei.user=?' : ''
	}`;
	const when = isPast ? 'e.starts<NOW()' : 'e.starts>=NOW()';
	const cond = mode.includes('Own') ? `${when} AND e.owner=?` : mode.includes('SurMay') ? `${when} AND ei.inter IN("sur","may")` : mode.includes('Int') ? `${when} AND ei.inter="int"` : when;
	return { sql: `${base} WHERE ${cond}`, order: sortMaps.events[sort] || sortMaps.events.recent };
};

// PARAM BUILDER ---------------------------------------------------------------
// Steps: build positional params to match buildQuery() output; keep the mapping explicit so it’s hard to break binding order accidentally.
const buildParams = ({ mode, userID, sort, devIsStable, eventID }: GalleryRequest): { params: any[] } => {
	const params: any[] = [];
	if (mode === 'deletePast') return { params: [userID, eventID] };
	if (['links', 'requests', 'trusts'].includes(mode)) {
		if (mode === 'requests') params.push(userID, userID);
		params.push(userID);
		params.push(userID, userID);
		params.push(userID, userID);
		if (mode === 'requests') params.push(userID, userID);
		if (mode === 'trusts') params.push(userID, userID);
		if (mode === 'links' && sort && ['incoming', 'outgoing'].includes(sort)) params.push(userID);
		return { params };
	}
	if (mode === 'blocks') return { params: [userID, userID] };
	if (['invitesIn', 'invitesOut'].includes(mode)) return { params: [userID, userID] };
	const needsInters = !devIsStable || mode.startsWith('past') || mode.includes('SurMay') || mode.includes('Int');
	const needsOwner = mode.includes('Own');
	if (needsInters) params.push(userID);
	if (needsOwner) params.push(userID);
	return { params };
};

const logger = getLogger('Gallery');
const MAX_OFFSET = 10000;

// GALLERY HANDLER -------------------------------------------------------------
// Steps: validate offset, branch special modes (deletePast), build query+params, execute, apply privacy filter only for event lists that require it, then return rows.
const Gallery = async (req: { body: GalleryRequest }, res: any) => {
	const { userID, devIsStable, mode, sort, offset, eventID } = req.body || {};
	const parsedOffset = Number(offset);
	const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? Math.min(parsedOffset, MAX_OFFSET) : 0;

	logger.info('gallery.request', { userID, mode, sort, offset: safeOffset, eventID, devIsStable, __skipRateLimit: true });
	let con: any;
	try {
		con = await Sql.getConnection();

		// DELETE PAST INTERACTION --------------------------------------------
		// Steps: soft-delete interaction for a past event; used by client cleanup flows without needing a dedicated endpoint.
		if (mode === 'deletePast') {
			if (!eventID) return res.status(400).json({ error: 'eventID required' });
			await con.execute('UPDATE eve_inters SET inter="del" WHERE user=? AND event=?', [userID, eventID]);
			return res.status(200).json({ success: true });
		}

		// BUILD & EXECUTE -----------------------------------------------------
		// Steps: build query and params, append limit/offset, then execute; all template logic lives in helpers so this stays readable.
		const { sql, order, orderNeedsUser } = buildQuery({ mode, sort: sort || '', devIsStable });
		const { params } = buildParams({ mode, userID, sort: sort || '', devIsStable, eventID });

		if (orderNeedsUser) params.push(userID);
		const finalSql = `${sql} ORDER BY ${order} LIMIT ? OFFSET ?`;
		params.push(PAGE, safeOffset);

		logger.info('gallery.query', { sql: finalSql, params, __skipRateLimit: true });
		const [data]: [any[], any] = await con.query(finalSql, params);
		let filteredData = data;

		// PRIVACIES FILTER ------------------------------------------------------
		// Steps: apply redis privacy filter for future event lists; link/block/invite lists are already per-user and don’t need event privacy filtering.
		if (!mode.startsWith('past') && !['links', 'requests', 'blocks', 'trusts', 'invitesIn', 'invitesOut'].includes(mode)) filteredData = await checkRedisAccess({ items: filteredData, userID });
		return res.status(200).json(filteredData);
	} catch (error: any) {
		if (error.code === 'ER_DUP_ENTRY') return res.status(200).end();
		logger.error('Gallery', { error, mode, userID });
		return Catcher({ origin: 'Gallery', error, res });
	} finally {
		// CLEANUP --------------------------------------------------------------
		// Steps: release connection on all paths so pool stays healthy.
		if (con) con.release();
	}
};

export default Gallery;
