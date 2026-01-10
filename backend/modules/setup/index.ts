import { getOrSaveCityData } from '../../utilities/helpers/location.ts';
import { getAuth } from '../../utilities/helpers/auth.ts';
import { registerDevice } from '../../utilities/helpers/device.ts';
import { createUserMeta } from '../../utilities/helpers/metasCreate.ts';
import { delFalsy, calculateAge } from '../../../shared/utilities.ts';
import { Sql, Catcher } from '../../systems/systems.ts';
import { jwtCreate } from '../jwtokens.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { encode, decode } from 'cbor-x';
import { Socket } from '../../systems/systems.ts';
import { normalizeSetupPayload } from './sanitize.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';
import { invalidateUserCache } from '../user.ts';

// META INDEXES ------------------------------------------
import { USER_META_INDEXES, USER_BASI_KEYS } from '../../../shared/constants.ts';
const { userPrivIdx, userBasiVersIdx, userAttendIdx } = USER_META_INDEXES;

/** ----------------------------------------------------------------------------
 * SETUP MODULE
 * Handles onboarding payload normalization, SQL persistence and Redis cache sync
 * for both first-time users and returning account edits.
 * --------------------------------------------------------------------------- */
// TODO will need to probably  move this into main content worker

// REDIS CLIENT REFERENCE ------------------------------------------------------
let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Setup writes to user metas/basi hashes and city filtering indexes during onboarding.
const ioRedisSetter = redisClient => (redis = redisClient);
const logger = getLogger('Setup');

// REQUEST BODY VALIDATION (MODULE-LOCAL) --------------------------------------
// Validations here are intentionally setup-domain scoped (not centralized).

// SANITIZE SESSION USER ID -----------------------------------------------------
// JWT middleware injects `userID` into `req.body`; we still validate shape/type here.
function sanitizeSetupSessionUserID(value) {
	if (value === undefined || value === null) throw new Error('unauthorized');
	const userIDNumber = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
	if (!Number.isInteger(userIDNumber) || userIDNumber <= 0) throw new Error('unauthorized');
	return userIDNumber;
}

// SANITIZE SESSION STATUS ------------------------------------------------------
// `is` controls introduction rules; accept only short, printable strings.
function sanitizeSetupSessionStatus(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error('badRequest');
	const status = value.trim();
	if (!status || status.length > 32) throw new Error('badRequest');
	return status;
}

// SANITIZE DEVICE PRINT --------------------------------------------------------
// Used for new-user bootstrap; login uses 8-128, fingerprint is typically 64.
function sanitizeSetupDevicePrint(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error('invalidDevicePrint');
	const print = value.trim();
	if (print.length < 8 || print.length > 128) throw new Error('invalidDevicePrint');
	return print;
}

/** ----------------------------------------------------------------------------
 * Handles user profile setup/update flow:
 * Steps:
 * 1) Normalize/validate payload (and resolve missing city rows if needed).
 * 2) Persist SQL state under a transaction (with throttling rules for sensitive fields).
 * 3) Update redis metas/basi/name indexes and emit socket updates so online clients converge.
 * --------------------------------------------------------------------------- */
async function Setup(req, res) {
	let con, citiesData, authData, pipeline;
	const { userID: rawUserID, is: rawIs, print: rawPrint, ...incoming } = req.body || {};
	const userID = sanitizeSetupSessionUserID(rawUserID);
	const is = sanitizeSetupSessionStatus(rawIs);
	const print = sanitizeSetupDevicePrint(rawPrint);
	let restData = normalizeSetupPayload(incoming, { isIntroduction: is === 'unintroduced' }) as any;
	if (!Object.keys(restData).length) return res.status(200).end();
	if (print && is !== 'unintroduced') throw new Error('unauthorized');

	// Create pipeline inside try block to ensure proper cleanup on error
	pipeline = redis.multi();

	try {
		con = await (Sql as any).getConnection();
		await con.beginTransaction();

		// CITIES RESOLUTION ---------------------------------------------------
		// Steps: resolve object-shaped city entries via DB helper, then store cities as a comma-separated id list for SQL.
		if (restData.cities) {
			const missingCities = restData.cities.filter(city => typeof city === 'object');
			if (missingCities.length) citiesData = await getOrSaveCityData(con, missingCities);
			restData.cities = restData.cities
				.map(city => {
					// NUMERIC IDS PASS THROUGH ---
					if (!isNaN(city)) return city;
					// MATCH BY ORIGINAL OR CANONICAL HASHID ---
					// getOrSaveCityData regenerates hashIDs; match by originalHashID (preserved from input) or canonical hashID.
					const match = citiesData?.find(c => c.hashID === city.hashID || (c as any).originalHashID === city.hashID);
					return match?.cityID;
				})
				.filter(id => id != null)
				.join(',');
		}

		// NORMALIZE BIRTH DATE ------------------------------------------------
		// Steps: keep date-only (YYYY-MM-DD) stable so timezone never shifts stored birthday.
		if (restData.birth) {
			// DATE-ONLY (NO TIMEZONE SHIFT) ---------------------------------------
			// `normalizeSetupPayload` already returns YYYY-MM-DD; keep it stable.
			if (typeof restData.birth === 'string') restData.birth = restData.birth.slice(0, 10);
		}

		if (!print && (restData.first || restData.last || restData.birth || restData.gender)) {
			// PERSONAL DATA THROTTLE --------------------------------------------
			// Steps: enforce cooldown windows and one-time age-change rule before persisting sensitive personal fields.
			let changedAge = false;
			const [rows] = await con.execute(`SELECT personals_at, changed_age FROM changes_tracking WHERE user = ?`, [userID]);
			const changesData = rows[0];

			if (restData.birth && changesData && changesData.changed_age) {
				if (['first', 'last', 'gender'].every(key => !restData[key])) throw new Error('ageAlreadyChanged');
				else delete restData.age;
			} else changedAge = true;

			if (new Date(changesData?.personals_at || 0).getTime() > Date.now() - 1000 * 60 * 60 * 24 * 120) throw new Error('personalsChangeTooRecent');
			if (changesData) {
				await con.execute(`UPDATE changes_tracking SET personals_at = NOW() ${changedAge ? ', changed_age = ?' : ''} WHERE user = ?`, changedAge ? [true, userID] : [userID]);
			} else {
				await con.execute(
					`INSERT INTO changes_tracking (user, personals_at ${changedAge ? ', changed_age' : ''}) VALUES (?, NOW() ${changedAge ? ', ?' : ''})`,
					changedAge ? [userID, true] : [userID]
				);
			}
		}

		// ARRAY TO STRING CONVERSION ---
		// Database stores these fields as comma/pipe-separated strings.
		if (Array.isArray(restData.basics)) restData.basics = restData.basics.join(',');
		if (Array.isArray(restData.indis)) restData.indis = restData.indis.join(',');
		if (Array.isArray(restData.groups)) restData.groups = restData.groups.join(',');
		if (Array.isArray(restData.favs)) restData.favs = restData.favs.join('|');
		if (Array.isArray(restData.exps)) restData.exps = restData.exps.join('|');

		// SQL UPDATE ----------------------------------------------------------
		// Steps: update only provided columns, bump basiVers for basi changes, or set status=newUser during introduction.
		const [columns, values] = Object.entries(restData).reduce((acc, [key, value]) => (acc[0].push(key), acc[1].push(value), acc), [[], []]);
		const sqlQuery = `UPDATE users SET ${columns.map(f => `${f} = ?`).join(', ')}${restData.priv ? ', flag = "pri"' : ''} ${
			!print ? (USER_BASI_KEYS.some(col => columns.includes(col)) ? ', basiVers = basiVers + 1' : '') : ', status = "newUser"'
		} WHERE id = ?`.replace('groups', '`groups`');
		await con.execute(sqlQuery, [...values, userID]);

		// NEW USER PATH -------------------------------------------------------
		// Steps: mint auth/tokens, register device, seed user summary watermarks, and write name/image index so discovery features can find the user.
		let deviceData;
		if (print) {
			authData = getAuth(userID);
			deviceData = await registerDevice(con, userID, print);
			await jwtCreate({ res, con, create: 'both', userID, print, is: 'newUser' });
			pipeline.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'last_dev', print.slice(0, 8)); // Don't add empty strings to sets - causes filtering issues ---------------------------

			// ADD NEW USER TO USER NAMES HASH ---------------------------------------------
			pipeline.hset(REDIS_KEYS.userNameImage, userID, encode([restData.first || '', restData.last || '', restData.imgVers || '']));
		} else {
			// EXISTING USER PATH -------------------------------------------------
			// Steps: update redis only when meta is already cached (user has attendance footprint); avoids rebuilding caches for users with no content presence.
			const metaBuffer = await redis.hgetBuffer(REDIS_KEYS.userMetas, userID);
			if (metaBuffer) {
				const meta = decode(metaBuffer);
				const metaUpdate = { ...restData } as any;
				if (restData.birth) metaUpdate.age = calculateAge(restData.birth, Date.now());
				createUserMeta(metaUpdate).forEach((v, i) => i !== userPrivIdx && v && (meta[i] = v));
				// Update eve_inters privacy when user changes their default privacy setting

				// TODO: uncomment once though through - probably would be a good idea to give user choice, if existing inters should be updated to new privacy setting too or not.
				// if (restData.priv && restData.priv !== 'ind' && meta[userPrivIdx] !== restData.priv) {
				// 	await con.execute(`UPDATE eve_inters SET priv = ? WHERE user = ? AND inter != 'del'`, [restData.priv, userID]);
				// 	meta[userPrivIdx] = restData.priv;
				// }

				// UPDATE BASI HASH --------------------------------------------------
				// Steps: bump basiVers and rewrite basi hash fields so clients can validate via versioning; also invalidate local cache.
				if (USER_BASI_KEYS.some(col => Object.keys(restData).includes(col))) {
					meta[userBasiVersIdx]++,
						pipeline.hset(`${REDIS_KEYS.userBasics}:${userID}`, ...USER_BASI_KEYS.flatMap(c => (restData[c] ? [c, restData[c]] : [])), 'basiVers', meta[userBasiVersIdx]);
					// Invalidate local cache in User module to ensure freshness
					invalidateUserCache(userID);
				}
				pipeline.hset(REDIS_KEYS.userMetas, userID, encode(meta)).hset(`${REDIS_KEYS.userSummary}:${userID}`, 'users', Date.now());

				// UPDATE CITY INDEXES ----------------------------------------------
				// Steps: when user has attendances, rewrite per-city meta/filtering entries so feeds reflect updated privacy/name.
				if (meta[userAttendIdx].length) {
					const userEventCities = new Map();
					const attendedEvents = meta[userAttendIdx].map(([eveID]) => eveID);
					const eventCities = await redis.hmget(REDIS_KEYS.eveCityIDs, ...attendedEvents);
					attendedEvents.forEach((eveID, i) => userEventCities.set(eveID, eventCities[i]));
					const userPriv = meta[userPrivIdx];

					for (const cityID of Array.from(userEventCities.values()).filter(Boolean)) {
						meta[userAttendIdx] = meta[userAttendIdx].filter(([eveID]) => userEventCities.get(eveID) === cityID);
						pipeline.hset(`${REDIS_KEYS.cityMetas}:${cityID}`, userID, encode(meta));
						pipeline.hset(`${REDIS_KEYS.cityFiltering}:${cityID}`, userID, userPriv);
					}
				}

				// UPDATE NAME/IMAGE INDEX ------------------------------------------
				// Steps: refresh the unified name/image hash for search/display and mark changed_name so downstream tasks can react.
				if (restData.first || restData.last || restData.imgVers !== undefined) {
					const [userData] = await con.execute(`SELECT first, last, imgVers FROM users WHERE id = ?`, [userID]);
					if (userData.length) {
						const { first, last, imgVers } = userData[0];
						pipeline.hset(REDIS_KEYS.userNameImage, userID, encode([restData.first || first || '', restData.last || last || '', (restData.imgVers ?? imgVers) || '']));
						await con.execute(`UPDATE changes_tracking SET changed_name = TRUE WHERE user = ?`, [userID]);
					}
				}
			}
			// SOCKET EMIT --------------------------------------------------------
			// Steps: emit minimal delta to user room so active sessions can update UI without polling.
			const socketIO = await (Socket as any)();
			if (socketIO) socketIO.to(String(userID)).emit('user', { data: restData, citiesData: citiesData });
		}

		// REDIS COMMIT ---------------------------------------------------------
		// Steps: exec pipeline and treat any per-command error as failure so SQL commit isn’t applied without redis cache coherence.
		const results = await (pipeline as any).exec();
		if (results.some(([err]) => err)) {
			throw new Error(
				`Redis pipeline failed: ${results
					.filter(([err]) => err)
					.map(([err]) => err.message)
					.join(', ')}`
			);
		}
		await con.commit();

		// RESPONSE BUILD ------------------------------------------------------
		// Steps: return citiesData/imgVers when present and include auth/device fields only for new-user path.
		const response: any = {
			...(citiesData && { citiesData }),
			...(restData.imgVers && { imgVers: restData.imgVers }),
		};
		if (authData) {
			response.auth = authData.auth;
			response.authEpoch = authData.epoch;
			response.authExpiry = authData.expiry;
			if (authData.isRotating) {
				response.previousAuth = authData.previousAuth;
				response.previousEpoch = authData.previousEpoch;
			}
		}
		// DEVICE DATA (NEW USER REGISTRATION) ---
		if (deviceData) {
			response.deviceID = deviceData.deviceID;
			response.deviceSalt = deviceData.salt;
			response.deviceKey = deviceData.deviceKey;
		}
		res.status(200).json(delFalsy(response));
	} catch (error) {
		if (con) await con.rollback();
		logger.error('Setup', { error, userID, is });
		(Catcher as any)({ origin: 'Setup', error, res, req });
	} finally {
		if (con) con.release();
	}
}

export { Setup, ioRedisSetter };
