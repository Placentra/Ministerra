import { getOrSaveCityData } from '../../utilities/helpers/location.ts';
import { createEveMeta } from '../../utilities/helpers/metasCreate.ts';
import { delFalsy, toMySqlDateFormat } from '../../../shared/utilities.ts';
import { Sql, Catcher } from '../../systems/systems.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { REDIS_KEYS, EVENT_META_INDEXES, EVENT_BASICS_KEYS, EVENT_DETAILS_KEYS } from '../../../shared/constants.ts';
import { getGeohash } from '../../utilities/helpers/location.ts';
import { saveImages } from '../images.ts';
import { normalizeEditorPayload } from './sanitize.ts';
import { Interests } from '../interests.ts';
import { invalidateEventCache } from '../event.ts';
import fs from 'fs/promises';

import { generateIDString } from '../../utilities/idGenerator.ts';
import { encode, decode } from 'cbor-x';
let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Editor writes directly to redis caches (metas/basi/deta, city indexes, title/owner lookup).
const ioRedisSetter = redisClient => (redis = redisClient);
const logger = getLogger('Editor');
let geohash;

// META INDEXES ------------------------------------------
const { evePrivIdx, eveCityIDIdx, eveBasiVersIdx, eveOwnerIdx, eveDetailsVersIdx } = EVENT_META_INDEXES;

// TODO Need to set lat and lng to cityLat and cityLng if locamode is city (either on client or here)
// TODO Should not allow ends to be more than 2 days after starts for friendly events

// MAIN EDITOR HANDLER ---------------------------------------------------------

/** ----------------------------------------------------------------------------
 * EDITOR
 * Main handler for creating, updating, and deleting events.
 * Manages complex state including ownership validation, city data resolution,
 * image processing, and Redis cache synchronization.
 * -------------------------------------------------------------------------- */
async function Editor(req, res) {
	let con, cityData, createdID;
	let {
		id: eventID,
		title,
		type,
		userID,
		shortDesc,
		locaMode,
		place,
		lat,
		owner,
		lng,
		priv,
		location,
		city,
		cityID,
		part,
		starts,
		ends,
		meetHow,
		meetWhen,
		detail,
		contacts,
		fee,
		organizer,
		links,
		mode,
		takeWith,
		inter,
		imgVers,
	} = normalizeEditorPayload(req.body);

	try {
		// OWNERSHIP GATE ------------------------------------------------------
		// Steps: for edits/deletes, read cached owner from redis and reject early if caller isn’t the owner (avoids DB work on unauthorized requests).
		if (eventID) {
			const raw = await redis.hgetBuffer(REDIS_KEYS.eveTitleOwner, eventID);
			const [, ownerVal] = raw ? decode(raw) : [];
			if (ownerVal !== userID) throw new Error('not owner');
		}

		con = await Sql.getConnection();

		// DELETE OWN EVENT ----------------------------------------------------
		// Steps: load event row, enforce “not started / not ended / not too close / not too many participants”, then soft-delete and enqueue rem marker in redis.
		if (mode === 'delete') {
			const [[ev]] = await con.execute('SELECT * FROM events WHERE id = ?', [eventID]);
			if (!ev || ev.owner !== userID || ev.flag === 'del') throw new Error(!ev ? 'událost nenalezena' : ev.owner !== userID ? 'nejsi vlastníkem' : 'již smazáno');

			const [now, start, end] = [Date.now(), new Date(ev.starts).getTime(), ev.ends ? new Date(ev.ends).getTime() : null];
			const [started, ended, close] = [start <= now, end && end < now, start - now < (ev.type.startsWith('a') ? 3600000 : 86400000)];
			const [badSur, badMay] = [ev.surely >= (ev.type.startsWith('a') ? 2 : 50), ev.maybe >= (ev.type.startsWith('a') ? 20 : 200)];

			if (ended || started || close || badSur || badMay) {
				const reasons = [
					ended && 'Již skončila',
					badSur && `Příliš mnoho potvrzených`,
					badMay && `Příliš mnoho možných`,
					started && 'Již začala',
					close && 'Méně než 24h/1h do začátku',
				].filter(Boolean);
				throw new Error(reasons.join(' + '));
			}

			await Promise.all([con.execute('UPDATE events SET flag = "del", changed = NOW(), basiVers = basiVers + 1 WHERE id = ?', [eventID]), redis.hset(REDIS_KEYS.remEve, eventID, now)]);
			invalidateEventCache(eventID);
			return res.status(200).end();
		}

		// CANCEL OWN EVENT ----------------------------------------------------
		// Steps: verify allowed timing (<=30min after start, not ended), bump versions in meta/basi, mark SQL flag, remove owner interaction, then invalidate cache.
		if (mode === 'cancel') {
			const [[ev]] = await con.execute('SELECT * FROM events WHERE id = ?', [eventID]);
			if (!ev || ev.owner !== userID || ev.flag === 'del' || ev.flag === 'can') throw new Error(!ev ? 'událost nenalezena' : ev.owner !== userID ? 'nejste vlastník' : 'již smazáno/zrušeno');
			if (ev.ends && Date.now() > new Date(ev.ends).getTime()) throw new Error('událost již skončila');
			if (ev.starts && Date.now() > new Date(ev.starts).getTime() + 1800000) throw new Error('lze zrušit jen do 30 minut od začátku');

			const meta = decode(await redis.hgetBuffer(REDIS_KEYS.eveMetas, eventID));
			meta[eveBasiVersIdx]++,
				await Promise.all([
					redis.hset(REDIS_KEYS.eveMetas, eventID, encode(meta)),
					redis.hset(`${REDIS_KEYS.eveBasics}:${eventID}`, 'canceled', true),
					con.execute('UPDATE events SET flag = "can", changed = NOW(), basiVers = basiVers + 1 WHERE id = ?', [eventID]),
					con.execute('DELETE FROM eve_inters WHERE event = ? AND user = ?', [eventID, userID]),
				]);
			invalidateEventCache(eventID);
			return res.status(200).end();
		}

		// PREPARE VARIABLES ---------------------------------------------------
		// Steps: build SQL columns/values list from sanitized payload; version counters are computed later from which field groups changed.
		const [values, cols, versCols] = [[], [], []];
		const vars = { priv, owner, cityID, title, type, shortDesc, place, part, location, starts, ends, meetHow, meetWhen, detail, contacts, fee, links, takeWith, organizer, imgVers };

		// ['starts', 'ends', 'meetWhen'].forEach(k => vars[k] && (vars[k] = new Date(vars[k]).toISOString().slice(0, 19).replace('T', ' ')));
		for (const [key, value] of Object.entries(vars)) {
			if (value !== undefined) {
				if (['starts', 'ends', 'meetWhen'].includes(key)) values.push(toMySqlDateFormat(value));
				else values.push(value);
				cols.push(key);
			}
		}

		// RESOLVE CITY & COORDS -----------------------------------------------
		// Steps: ensure city exists (or create), normalize coords into MySQL Point, and apply friendly-event constraints (imgVers=0).
		if (city && !cityID) (cityData = (await getOrSaveCityData(con, [city]))[0]), cols.push(`cityID`), values.push(cityData.cityID), (vars.cityID = cityData.cityID);
		if (type?.startsWith('a')) cols.push(`imgVers`), values.push(0);
		if (lng && lat) cols.push(`coords`), values.push(...[lng, lat]);

		// CREATE NEW EVENT ----------------------------------------------------
		if (!eventID) {
			if (type === undefined || !starts || !cols.includes('cityID') || [lat, lng].some(val => (location ? !val : val))) throw new Error('missingData');
			const startMs = new Date(starts).getTime();
			if (isNaN(startMs) || startMs < Date.now() - 300000) throw new Error('startsMustBeInFuture');

			// GENERATE SNOWFLAKE ID ---
			// Steps: generate globally unique ID, insert event, run side effects.
			try {
				eventID = generateIDString();
				const placeholders = cols.map(c => (c === 'coords' ? 'Point(?, ?)' : '?'));
				await con.execute(`INSERT INTO events (id, ${cols.join(', ')}, owner, flag) VALUES (?, ${placeholders.join(',')}, ?, 'new')`, [eventID, ...values, userID]);
				createdID = eventID;

				// SIDE EFFECTS ---
				// Steps: save deferred images (if present), set initial interest (if requested), and write redis indexes for city and title/owner lookup.
				const tasks = [
					req.processedImages && saveImages(req.processedImages, eventID, 1, 'events'),
					inter && Interests({ eventID, userID, inter, priv, con }),
					redis.hset(REDIS_KEYS.eveCityIDs, eventID, vars.cityID),
					title && redis.hset(REDIS_KEYS.eveTitleOwner, eventID, encode([title.length > 40 ? title.slice(0, 39) + '…' : title, userID])),
				];
				await Promise.all(tasks);
			} catch (error) {
				logger.error('createEvent', { error, userID, eventID });
				throw new Error('eventCreateFailed');
			}
		} else {
			// EDIT EXISTING EVENT ---------------------------------------------
			const [[ev]] = await con.execute(`SELECT flag, imgVers, cityID, type, priv FROM events WHERE id = ? AND owner = ? AND flag IN ('ok', 'new')`, [eventID, userID]);
			if (!ev) throw new Error('unauthorized');

			const isFriend = ev.type.startsWith('a');
			// Prevent changing critical fields (type, city) for friendly events or across type boundaries
			// Guard vars.type checks since type may be undefined when user isn't changing it
			if (
				(isFriend
					? (vars.cityID && vars.cityID != ev.cityID) || (vars.type !== undefined && (vars.type != ev.type || !vars.type.startsWith('a')))
					: vars.type !== undefined && vars.type.startsWith('a')) ||
				(vars.priv && ev.priv !== vars.priv)
			)
				throw new Error('badRequest');

			async function editEventInSQL() {
				// VERSION INCREMENTS ----------------------------------------------
				// Steps: bump basiVers/detaVers only when fields in their groups changed so clients can do version-based cache validation.
				if (EVENT_BASICS_KEYS.some(k => vars[k])) versCols.push(`basiVers = basiVers + 1`);
				if (EVENT_DETAILS_KEYS.some(k => vars[k])) versCols.push(`detaVers = detaVers + 1`);

				const query = `UPDATE events SET ${cols.map(c => `${c} = ${c === 'coords' ? 'Point(?, ?)' : '?'}`).join(', ')}${versCols.length ? `, ${versCols.join(', ')}` : ''}${
					locaMode === 'city' ? ', location = NULL, coords = NULL' : locaMode === 'radius' ? ', location = NULL' : ''
				} WHERE events.id = ? AND events.owner = ?`;

				await con.execute(query, [...values, eventID, userID]);
				if (req.processedImages && typeof imgVers === 'string') {
					const [[row]] = await con.execute('SELECT imgVers FROM events WHERE id = ?', [eventID]);
					await saveImages(req.processedImages, eventID, Number(String(row?.imgVers).split('_')[0] || 0), 'events');
				}
				if (imgVers === 0)
					for (const size of ['', 'S', 'L'])
						await fs.unlink(`public/events/${eventID}_${ev.imgVers}${size}.webp`).catch(err => logger.alert('Editor.unlink_failed', { error: err, eventID }));
			}

			// UPDATE REDIS CACHE ----------------------------------------------
			// Steps: update meta + basi/deta hashes, migrate city indexes when changed, refresh title/owner lookup, then invalidate local cache.
			async function updateRedisCache() {
				const [meta, multi] = [decode(await redis.hgetBuffer(REDIS_KEYS.eveMetas, eventID)), redis.multi()];
				const [curPriv, curCity, curOwner] = [meta[evePrivIdx], meta[eveCityIDIdx], meta[eveOwnerIdx]];
				const cityChanged = !!(vars.cityID && vars.cityID !== curCity);

				// Handle city migration in Redis
				if (cityChanged) {
					multi.hset(REDIS_KEYS.eveCityIDs, eventID, vars.cityID);
					multi.hdel(`${curPriv === 'pub' ? REDIS_KEYS.cityPubMetas : REDIS_KEYS.cityMetas}:${curCity}`, eventID);
					multi.hdel(`${REDIS_KEYS.cityFiltering}:${curCity}`, eventID);
				}

				// Update meta array and version keys
				geohash ??= getGeohash();
				const metaUpdate = { ...vars } as any;
				if (vars.starts) metaUpdate.starts = new Date(vars.starts).getTime().toString(36);
				if (lat && lng && geohash?.encode) metaUpdate.geohash = geohash.encode(lat, lng, 9);
				createEveMeta(metaUpdate).forEach((v, i) => v && (meta[i] = v));
				(Object.entries({ basiVers: [EVENT_BASICS_KEYS, REDIS_KEYS.eveBasics, eveBasiVersIdx], detaVers: [EVENT_DETAILS_KEYS, REDIS_KEYS.eveDetails, eveDetailsVersIdx] }) as any).forEach(
					([k, [cols, redisKey, metaIdx]]: any) =>
						(cols as any[]).some((c: any) => (vars as any)[c]) &&
						multi.hset(
							`${redisKey}:${eventID}`,
							...(cols as any[]).flatMap((c: any) => ((vars as any)[c] ? [c, (vars as any)[c]] : [])),
							k,
							(meta[metaIdx] = Number(meta[metaIdx] || 0) + 1)
						)
				);

				const encodedMeta = encode(meta);
				const finPriv = meta[evePrivIdx];
				multi.hset(REDIS_KEYS.eveMetas, eventID, encodedMeta);
				const targetCityID = vars.cityID || curCity;
				const targetCityMetas = `${finPriv === 'pub' ? REDIS_KEYS.cityPubMetas : REDIS_KEYS.cityMetas}:${targetCityID}`;
				multi.hset(targetCityMetas, eventID, encodedMeta);
				if (await redis.hexists(REDIS_KEYS.topEvents, eventID)) multi.hset(REDIS_KEYS.topEvents, eventID, encodedMeta);
				multi.hset(`${REDIS_KEYS.cityFiltering}:${targetCityID}`, eventID, `${finPriv}:${vars.owner || curOwner || ''}`);

				// Update title/owner lookup ifp changed
				if (title || owner) {
					let [curTitle, curOwner] = [null, null];
					const rawTO = await redis.hgetBuffer(REDIS_KEYS.eveTitleOwner, eventID);
					if (rawTO) [curTitle, curOwner] = decode(rawTO);
					else {
						const [[row]] = await con.execute('SELECT title, owner FROM events WHERE id = ?', [eventID]);
						if (row) (curTitle = row.title), (curOwner = row.owner);
					}
					const [newName, newOwner] = [title || curTitle, owner || curOwner || userID];
					if (newName && newOwner) multi.hset(REDIS_KEYS.eveTitleOwner, eventID, encode([(newName || '').length > 40 ? newName.slice(0, 39) + '…' : newName, newOwner]));
				}
				await multi.exec();

				// INVALIDATE LOCAL CACHE --------------------------------------
				// Steps: drop in-process cache so subsequent reads observe the freshly updated redis values.
				invalidateEventCache(eventID);
			}
			await Promise.all([editEventInSQL(), updateRedisCache()]);
		}
		res.status(200).json(delFalsy({ cityData, createdID, imgVers: req.body.imgVers }));
	} catch (error) {
		logger.error('Editor', { error, mode, eventID, userID });
		Catcher({ origin: 'Create', error, res });
	} finally {
		if (con) con.release();
	}
}
export { Editor, ioRedisSetter };
