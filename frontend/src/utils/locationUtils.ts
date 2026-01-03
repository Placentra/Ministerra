import axios from 'axios';
import { notifyGlobalError } from '../hooks/useErrorsMan';

// PROCESS LOCATION ITEMS -------------------------------------------------------
// Steps: map raw geocoder items into a stable internal shape by extracting region/county/country, then normalizing “is” type, then computing hashID only when we have usable coords to avoid collisions.
export function processLocationItems(items) {
	const result = items.map(item => {
		const { name, label, position, type, location, regionalStructure } = item;

		// REGION STRUCTURE EXTRACTION -----------------------------------------
		// Steps: derive human-readable geographic buckets from provider structure so UI can display consistent strings.
		const city = regionalStructure?.find(r => r.type === 'regional.municipality')?.name;
		const region = regionalStructure
			?.find(r => r.name.toLowerCase().includes('kraj'))
			?.name.replace('kraj', '')
			.replace('Kraj ', '')
			.trim();
		const county = regionalStructure
			?.filter(r => r.name.toLowerCase().includes('okres'))[0]
			?.name.replace('okres ', '')
			.replace('Okres ', '')
			.trim();
		const country = regionalStructure?.find(r => r.type === 'regional.country')?.name;
		const part = regionalStructure?.find(r => r.type === 'regional.municipality_part')?.name || null;
		// TYPE MAPPING --------------------------------------------------------
		// Steps: convert provider types into our internal enum so downstream filters can reason about it without knowing provider strings.
		const is =
			type === 'regional.municipality'
				? 'city'
				: type === 'regional.municipality_part'
				? 'part'
				: type === 'poi'
				? 'place'
				: type === 'regional.street'
				? 'street'
				: type === 'regional.address'
				? 'address'
				: 'location';
		// HASH ID -------------------------------------------------------------
		// Steps: generate hash only when coords exist (or city exists) so we don’t create stable-but-wrong keys for coord-less suggestions.
		const hasValidPosition = position && (position.lat || position.lon);
		const hashID = hasValidPosition ? generateLocationHash({ city: is === 'city' ? name : city, part: is === 'part' ? name : part, lat: position.lat, lng: position.lon }) : null;

		return {
			is,
			...(is === 'city' ? { city: name, ...(hashID && { hashID }) } : { city }),
			...((is === 'place' || is === 'street' || is === 'address') && { place: name }), // PLACE FIELD: stores name for POI, street, and address types ----
			...(is === 'part' ? { part: name, ...(hashID && { hashID }) } : { part }),
			location,
			country,
			region,
			county,
			lat: position?.lat,
			lng: position?.lon,
			label,
		};
	});
	return result;
}

// GENERATE LOCATION HASH -------------------------------------------------------
// Steps: normalize lat/lng to coarse buckets (2 decimals) so minor provider jitter doesn’t create cache misses, then hash a stable string into a short base36 token.
export function generateLocationHash({ city, part, lat = 0, lng = 0 }) {
	// Return null for items without valid coordinates to prevent cache collisions
	if ((lat === undefined || lat === null || lat === 0) && (lng === undefined || lng === null || lng === 0)) {
		// Only generate hash if we have at least city name
		if (!city) return null;
	}
	const roundedLat = lat ? Math.round(lat * 100) / 100 : 0;
	const roundedLon = lng ? Math.round(lng * 100) / 100 : 0;
	const hashInput = `${city}|${part}|${roundedLat}|${roundedLon}`;

	// Use BigInt to avoid 32-bit integer overflow with bitwise ops
	let hash = 5381n;
	for (let i = 0; i < hashInput.length; i++) {
		hash = ((hash << 5n) + hash + BigInt(hashInput.charCodeAt(i))) & 0xffffffffn;
	}
	return Number(hash).toString(36).substring(0, 10);
}

// GET LOCATION SUGGESTIONS -----------------------------------------------------
// Steps: build provider type filters from locaMode + UI context, call backend proxy (`/locations`), then filter out already-picked cities (hashIDs) and optionally restrict results to a target city.
export async function fetchLocationSuggestions(query, options: any = {}, isIntroduction = false) {
	const { locaMode = null, inMenu, cities = [], nowAt, restrictCity = null } = options || {};
	if (!query || query.length < 2 || (restrictCity && locaMode === 'city')) return [];

	try {
		const params = [];

		if (nowAt === 'setup' || inMenu || locaMode === 'city') {
			params.push('regional.municipality');
			if (inMenu) params.push('regional.municipality_part');
		} else if (locaMode === 'exact') {
			// EXACT MODE: POIs and addresses, no street suggestions ---------------------------
			params.push('poi', 'regional.address');
		} else if (locaMode === 'radius') {
			// RADIUS MODE: POIs, streets, and addresses ---------------------------
			params.push('poi', 'regional.street', 'regional.address');
		}

		if (params.length === 0) params.push('regional.municipality');
		// QUERY SHAPING -------------------------------------------------------
		// Steps: keep query as-is for city restriction (backend already uses params); avoid client-side concatenation that could degrade search quality.
		const searchQuery = restrictCity ? `${query}` : query;
		const response = await axios.post('/locations', { query: searchQuery, params, ...(isIntroduction && { useAuthToken: true }) });
		const hashIDs = new Set(cities.map(item => item?.hashID || item));
		if (response.data && response.data.items) {
			let items = response.data.items.filter(item => !hashIDs.has(generateLocationHash(item)));
			// RESTRICTION FILTER ------------------------------------------------
			// Steps: when city is restricted, keep only results whose location/structure matches that city to avoid cross-city noise.
			if (restrictCity)
				items = items.filter(
					item => item.location?.toLowerCase().includes(restrictCity.toLowerCase()) || item.regionalStructure?.some(r => r.name?.toLowerCase() === restrictCity.toLowerCase())
				);
			return items;
		}

		return [];
	} catch (error) {
		notifyGlobalError(error, 'Nepodařilo se načíst návrhy míst.');
		return [];
	}
}

// TODO movie to backend, otherwise someone can steal the api key
// FIND NEAREST CITY ------------------------------------------------------------
// Steps: query geocoder for city candidates, compute distance against provided coords, keep shortest, then normalize into our internal city item (processLocationItems).
export async function findNearestCity(cityName, coordinates) {
	try {
		let nearestCity = null;
		const response = await axios.post('/locations', { query: cityName, params: ['regional.municipality'] });
		if (response && response.data.items?.length > 0) {
			let shortestDistance = Infinity;

			for (const item of response.data.items) {
				if (item.position && item.position.lat && item.position.lon) {
					const distance = getDistance(item.position.lat, item.position.lon, coordinates.lat, coordinates.lng);
					if (distance < shortestDistance) (shortestDistance = distance), (nearestCity = item);
				}
			}
		}

		if (nearestCity) return processLocationItems([nearestCity])[0];
		else return null;
	} catch (error) {
		notifyGlobalError(error, 'Nepodařilo se najít nejbližší město.');
		return null;
	}
}

// GET DISTANCE -----------------------------------------------------------------
// Steps: compute geodesic distance between two lat/lon points (Vincenty-style iterative); returns kilometers and falls back to 0 on non-convergence/errors.
export function getDistance(lat1, lon1, lat2, lon2) {
	try {
		const [a, f] = [6378137, 1 / 298.257223563],
			b = (1 - f) * a;
		[lat1, lon1, lat2, lon2] = [lat1, lon1, lat2, lon2].map(deg => (deg * Math.PI) / 180);
		const [L, U1, U2] = [lon2 - lon1, Math.atan((1 - f) * Math.tan(lat1)), Math.atan((1 - f) * Math.tan(lat2))];
		const [sinU1, cosU1, sinU2, cosU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
		let [lambda, iterLimit] = [L, 100],
			sinSigma,
			cosSigma,
			sigma,
			sinAlpha,
			cosSqAlpha,
			cos2SigmaM,
			lambdaP;
		do {
			const [sinLambda, cosLambda] = [Math.sin(lambda), Math.cos(lambda)];
			const sinSigmaSq = (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2;
			if (!sinSigmaSq) return 0;
			[sinSigma, cosSigma] = [Math.sqrt(sinSigmaSq), sinU1 * sinU2 + cosU1 * cosU2 * cosLambda];
			sigma = Math.atan2(sinSigma, cosSigma);
			sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
			cosSqAlpha = 1 - sinAlpha ** 2;
			cos2SigmaM = cosSqAlpha ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
			const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
			[lambdaP, lambda] = [lambda, L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)))];
		} while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);
		if (!iterLimit) return 0;
		const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
		const [A, B] = [1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq))), (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))];
		const deltaSigma = B * sinSigma * (cos2SigmaM + (B / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
		return (b * A * (sigma - deltaSigma)) / 1000;
	} catch (error) {
		console.error('Error calculating distance:', error);
		return 0;
	}
}
