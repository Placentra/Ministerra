import { Catcher } from '../systems/systems';
import axios from 'axios';
import { getLogger } from '../systems/handlers/logging/index';
import { LRUCache } from 'lru-cache';

// LOCATIONS MODULE -------------------------------------------------------------
// Thin proxy over Mapy.cz geocode API:
// - keeps GEOCODE_API_KEY server-side
// - enforces minimal request validation and forwards type filters
// - caches results to reduce external API costs and latency

const logger = getLogger('Locations');

// API CACHE -------------------------------------------------------------------
// Steps: cache successful geocode responses keyed by (query,types) so repeated frontend typing doesn’t repeatedly hit the provider.
const locationsCache = new LRUCache({
	max: 1000, // Store top 1000 queries
	ttl: 1000 * 60 * 60 * 24, // 24 hours (geocode data is very stable)
});

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
		// CACHE CHECK ----------------------------------------------------------
		// Steps: cache is checked before any env validation/network call; this keeps hot queries fast and cheap.
		const cacheKey = `${query.trim()}|${params.sort().join(',')}`;
		const cached = locationsCache.get(cacheKey);
		if (cached) return res.status(200).json(cached);

		// API REQUEST ----------------------------------------------------------
		// Steps: build URL with fixed host/path and server-side api key; forward requested type filters.
		if (!process.env.GEOCODE_API_KEY) throw new Error('GEOCODE_API_KEY not configured');
		const url = new URL('https://api.mapy.cz/v1/geocode');
		url.searchParams.set('lang', 'cs');
		url.searchParams.set('apikey', process.env.GEOCODE_API_KEY);
		url.searchParams.set('query', query.trim());
		url.searchParams.set('limit', '15');
		for (const param of params) url.searchParams.append('type', param);

		// FETCH + CACHE + RETURN ----------------------------------------------
		// Steps: fetch response, cache it, then return to client; errors are caught and routed through Catcher.
		const response = (await axios.get(url.toString())).data;
		locationsCache.set(cacheKey, response);
		res.status(200).json(response);
	} catch (error) {
		logger.error('Locations', { error, query, params });
		Catcher({ origin: 'Locations', error, res });
	}
}

export { Locations };
