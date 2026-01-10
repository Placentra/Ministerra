import { Catcher } from '../systems/systems.ts';
import axios from 'axios';
import { getLogger } from '../systems/handlers/loggers.ts';
import { LRUCache } from 'lru-cache';
import { encode, decode } from 'cbor-x';

// LOCATIONS MODULE -------------------------------------------------------------
// Thin proxy over Mapy.cz geocode API:
// - keeps GEOCODE_API_KEY server-side
// - enforces minimal request validation and forwards type filters
// - hybrid caching (Redis + LRU) to reduce external API costs across cluster

const logger = getLogger('Locations');

// REDIS CLIENT REFERENCE ------------------------------------------------------
let redis: any;

// REDIS CLIENT SETTER ---------------------------------------------------------
// Steps: inject redis client at startup so cache can be shared across workers.
export const ioRedisSetter = (r: any): any => (redis = r);

// HYBRID CACHE SYSTEM ---------------------------------------------------------
// Steps: LRU cache for fast local hits (avoids Redis round-trip), Redis for cluster-wide sharing.
// Rationale: geocoding is expensive; with multiple workers, same query would hit provider N times.
// Redis ensures one worker's cache benefits all others, while LRU keeps hot queries sub-millisecond.

// LOCAL LRU CACHE (SECONDARY) ---
// Fast in-process cache for frequently accessed queries within this worker.
// Size: ~100k entries × ~3KB = ~300MB per worker.
// Rationale: geocoding covers cities, places, addresses, POIs - many unique queries.
// Memory cost is negligible compared to provider API costs and latency.
const locationsLRU = new LRUCache({
	max: 100000, // Large cache for cities, places, addresses, POIs (geocode responses ~2-5KB each)
	ttl: 1000 * 60 * 60 * 24 * 7, // 7 days (shorter than Redis to encourage refresh)
});

// REDIS CACHE KEY PREFIX ---
// Centralized key pattern for geocode cache entries.
const GEOCODE_CACHE_PREFIX = 'geocode:';

// LOCATIONS HANDLER -----------------------------------------------------------

// LOCATIONS ---
// Proxy to Mapy.cz geocode API with minimal validation and type filtering.
// Keeps backend key hidden while letting FE request multiple result types.
// Steps: validate query, serve from cache when present, otherwise call provider with server-side api key, cache response, then return.
async function Locations(req, res) {
	const { query, params = [] } = req.body;

	// VALIDATION -------------------------------------------------------------
	// Steps: enforce string input and minimal length so external API isn’t spammed with empty/garbage requests.
	if (!query || typeof query !== 'string' || query.trim().length < 2) {
		return res.status(400).json({ error: 'Query parameter is required and must be at least 2 characters' });
	}

	try {
		// CACHE KEY GENERATION ---
		// Steps: normalize query and params into stable cache key.
		const cacheKey = `${query.trim()}|${params.sort().join(',')}`;
		const redisKey = `${GEOCODE_CACHE_PREFIX}${cacheKey}`;

		// HYBRID CACHE LOOKUP ---
		// Steps: check LRU first (fastest), then Redis (shared), then provider (expensive).
		// LRU CACHE CHECK (FAST PATH) ---
		const lruCached = locationsLRU.get(cacheKey);
		if (lruCached) {
			logger.debug('Locations cache hit (LRU)', { query, cacheKey });
			return res.status(200).json(lruCached);
		}

		// REDIS CACHE CHECK (CLUSTER SHARED) ---
		// Steps: if Redis available, check shared cache to avoid duplicate provider calls across workers.
		if (redis) {
			try {
				const redisCached = await redis.getBuffer(redisKey);
				if (redisCached) {
					const decoded = decode(redisCached);
					// POPULATE LRU FROM REDIS ---
					// Steps: warm local cache so next request is even faster.
					locationsLRU.set(cacheKey, decoded);
					logger.debug('Locations cache hit (Redis)', { query, cacheKey });
					return res.status(200).json(decoded);
				}
			} catch (redisErr) {
				// REDIS ERROR FALLBACK ---
				// Steps: if Redis fails, continue to provider rather than blocking request.
				logger.warn('Locations Redis cache read failed', { error: redisErr, query, cacheKey });
			}
		}

		// PROVIDER REQUEST (CACHE MISS) ---
		// Steps: build URL with fixed host/path and server-side api key; forward requested type filters.
		if (!process.env.GEOCODE_API_KEY) throw new Error('GEOCODE_API_KEY not configured');
		const url = new URL('https://api.mapy.cz/v1/geocode');
		url.searchParams.set('lang', 'cs');
		url.searchParams.set('apikey', process.env.GEOCODE_API_KEY);
		url.searchParams.set('query', query.trim());
		url.searchParams.set('limit', '15');
		for (const param of params) url.searchParams.append('type', param);

		// FETCH FROM PROVIDER ---
		// Steps: call external API, then cache in both layers before returning.
		const response = (await axios.get(url.toString())).data;

		// DUAL CACHE WRITEBACK ---
		// Steps: store in LRU (fast local) and Redis (shared cluster) with different TTLs.
		// LRU CACHE (LOCAL) ---
		locationsLRU.set(cacheKey, response);

		// REDIS CACHE (CLUSTER) ---
		// Steps: cache in Redis with longer TTL (24h) so all workers benefit; use CBOR for efficiency.
		if (redis) {
			try {
				// 30 DAY TTL ---
				// Geocode data is extremely stable (cities don't move, addresses rarely change).
				// Long TTL reduces provider costs and improves response times across all workers.
				// Use setex with encoded buffer (ioredis accepts Buffer directly)
				await redis.setex(redisKey, 86400 * 30, encode(response));
				logger.debug('Locations cached (Redis)', { query, cacheKey });
			} catch (redisErr) {
				// REDIS WRITE ERROR (NON-BLOCKING) ---
				// Steps: log but don't fail request if Redis write fails.
				logger.warn('Locations Redis cache write failed', { error: redisErr, query, cacheKey });
			}
		}

		res.status(200).json(response);
	} catch (error) {
		logger.error('Locations', { error, query, params });
		Catcher({ origin: 'Locations', error, res });
	}
}

export { Locations };
