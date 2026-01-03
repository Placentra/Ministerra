// LOCATION & CITIES ============================================================
// Sequence: normalize location-ish inputs into stable identifiers, then attempt
// Redis fast-paths first, then fall back to SQL writes/reads, then re-cache.
// =============================================================================

import { Sql } from '../../systems/mysql/mysql.ts';
import { encode, decode } from 'cbor-x';
import { getLogger } from '../../systems/handlers/logging/index.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

import { Redis } from 'ioredis';

const logger = getLogger('Helpers:Location');

let redis, geohash;

// REDIS CLIENT INJECTION ---
// Steps: accept external redis instance at boot, then reuse it for all cache paths.
export const ioRedisSetter = r => (redis = r);

// GEOHASH LAZY LOAD ---
// Steps: load the module once (async) so cold boot is cheap, then expose accessor.
import('latlon-geohash').then(module => (geohash = module.default));
// GET GEOHASH ---
// Steps: return the lazily-loaded module reference so callers can gate usage on availability.
export const getGeohash = () => geohash;

// GENERATE LOCATION HASH -------------------------------------------------------
// used for stable comparison between third party location providers and our own database
export function generateLocationHash({ city, part, lat, lng }) {
	// INPUT NORMALIZATION ---
	// Steps: snap to ~1km-ish precision so “same city, slightly different GPS” stays identical.
	const roundedLat = Math.round(lat * 100) / 100;
	const roundedLon = Math.round(lng * 100) / 100;
	const hashInput = `${city}|${part}|${roundedLat}|${roundedLon}`;

	// HASH ACCUMULATION ---
	// Steps: run djb2-like mixing with BigInt so bit-ops don’t overflow into nonsense.
	let hash = 5381n;
	for (let i = 0; i < hashInput.length; i++) {
		hash = ((hash << 5n) + hash + BigInt(hashInput.charCodeAt(i))) & 0xffffffffn;
	}
	// OUTPUT SHAPING ---
	// Steps: base36 compress for Redis/SQL storage, then trim for fixed-ish size keys.
	return Number(hash).toString(36).substring(0, 10);
}

// GET OR SAVE CITY DATA -------------------------------------------------------
// Steps: split numeric IDs vs city objects, resolve whatever can be resolved from Redis,
// then only hit SQL for the truly-new cities, then push everything back into Redis
// so the next request stays on the fast path.
export async function getOrSaveCityData(con, cities) {
	// REQUEST TRACE ------------------------------------------------------------
	// Steps: log start with count so cache-miss storms can be diagnosed without logging every city object payload.
	logger.info('helpers.get_or_save_city_data.start', { cityCount: cities.length, __skipRateLimit: true });
	let obtainedCon = false;

	try {
		let existingCities = [],
			foundByhashIDs = [];

		// INPUT SPLIT ---
		// Steps: keep numeric cityIDs (already canonical) separate from objects (need resolution).

		const [cityIDsOnly, cityObjects] = cities.reduce(
			(acc, city) => {
				typeof city === 'object' ? acc[1].push(city) : acc[0].push(city);
				return acc;
			},
			[[], []]
		);

		// FAST PATH: CITYID -> CITYDATA ---
		// Steps: hmget packed CBOR by known IDs, then early-return if everything was satisfied.
		if (cityIDsOnly.length)
			existingCities = (await redis.hmgetBuffer(REDIS_KEYS.citiesData, ...cityIDsOnly.map(String)))
				.map((data, i) => (data ? { cityID: cityIDsOnly[i], ...decode(data) } : null))
				.filter(Boolean);

		const validExistingCities = existingCities.filter(c => c !== null);

		if (validExistingCities.length === cities.length) return validExistingCities;

		// SECOND FAST PATH: HASHID -> CITYID -> CITYDATA ---
		// Steps: resolve hashIDs to cityIDs (dedupe key), then fetch the actual city payloads.
		const hashIDs = cityObjects.map(c => c.hashID).filter(h => !!h);

		if (hashIDs.length) {
			const existingCityIDs = (await redis.hmget(REDIS_KEYS.cityIDs, ...hashIDs)).filter(id => id);
			if (existingCityIDs.length)
				foundByhashIDs = (await redis.hmgetBuffer(REDIS_KEYS.citiesData, ...existingCityIDs))
					.map((data, i) => (data ? { cityID: Number(existingCityIDs[i]), ...decode(data) } : null))
					.filter(Boolean);
		}
		const validFoundByHashIDs = foundByhashIDs.filter(c => c !== null);
		const foundHashIDsSet = new Set(validFoundByHashIDs.map(c => c.hashID));

		// Combine our partial results
		const allFoundSoFar = [...validExistingCities, ...validFoundByHashIDs];

		// SQL SLOW PATH: INSERT NEW CITIES ---
		// Steps: only carry forward hashIDs that weren’t in Redis, then insert-ignore to survive races.
		const newCities = cityObjects.filter(c => !c.hashID || !foundHashIDsSet.has(c.hashID));
		const newCitiesWithIDs = [];

		if (newCities.length) {
			try {
				// CONNECTION ACQUISITION ---
				// Steps: reuse provided connection if present; otherwise acquire+release locally.
				if (!con) {
					con = await Sql.getConnection();
					obtainedCon = true;
				}

				// HASH ID FINALIZATION ---
				// Steps: ensure every new city has a stable hash before insert (required for re-select).
				for (const city of newCities) city.hashID = generateLocationHash(city);

				// TRANSACTIONAL WRITE + READBACK ---
				// Steps: insert-ignore (idempotent), then select IDs by hash so we can cache deterministically.
				await con.beginTransaction();
				await con.execute(
					/*sql*/ `INSERT IGNORE INTO cities (city, coords, hashID, county, region, part, country) VALUES ${newCities.map(() => '(?, POINT(?, ?), ?, ?, ?, ?, ?)').join(', ')}`,
					newCities.flatMap(city => [
						city.city,
						(city.lng || 0).toFixed(6),
						(city.lat || 0).toFixed(6),
						city.hashID,
						city.county || null,
						city.region || null,
						city.part || null,
						city.country || null,
					])
				);

				// ID RECOVERY ---
				// Steps: re-select by hashIDs (covers both freshly inserted and raced-in rows).
				const newhashIDs = newCities.map(c => c.hashID);
				const [newCityIDRows] = await con.execute(/*sql*/ `SELECT id, hashID FROM cities WHERE hashID IN (${newhashIDs.map(() => '?').join(',')})`, newhashIDs);

				newCitiesWithIDs.push(
					...(newCities
						.map(city => {
							const matchingRow = newCityIDRows.find(row => row.hashID === city.hashID);
							if (!matchingRow) {
								logger.alert('helpers.city_id_not_found', { hashID: city.hashID });
								return null;
							}
							return { ...city, cityID: Number(matchingRow.id) };
						})
						.filter(c => c !== null))
				);

				await con.commit();

				// CACHE WRITEBACK ---
				// Steps: cache both directions (id->payload, hash->id) so the next call avoids SQL entirely.
				const txn = redis.multi();
				for (const city of newCitiesWithIDs) {
					if (city.cityID && city.hashID) {
						txn.hset(REDIS_KEYS.citiesData, String(city.cityID), encode(city));
						txn.hset(REDIS_KEYS.cityIDs, city.hashID, String(city.cityID));
					}
				}
				await txn.exec();
			} catch (error) {
				if (con) await con.rollback();
				throw error;
			}
		}

		// FINAL MERGE ---
		// Steps: return already-existing payloads plus the newly-created ones (both now cache-backed).
		return [...allFoundSoFar, ...newCitiesWithIDs];
	} catch (error) {
		logger.error('helpers.get_or_save_city_data_failed', { error, cityCount: cities.length });
		throw error;
	} finally {
		// CONNECTION CLEANUP ---
		// Steps: only release if we acquired it inside this helper.
		if (obtainedCon && con) con.release();
	}
}
