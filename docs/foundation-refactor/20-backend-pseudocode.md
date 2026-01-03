# 20 — Backend Pseudocode (Best Version)

This is intentionally written like “new code you would write”, not a diff of the old system.
It demonstrates clean separation while keeping your current capabilities.

> Note: Comments use the same **ALL CAPS + dashed scaffolding** style you prefer.

---

## Data contracts (wire-level)

```ts
// FOUNDATION LOAD MODES ---
// Mirrors your current `FOUNDATION_LOADS` behavior.
type FoundationLoadMode =
	| 'auth' // return auth/keys only
	| 'fast' // minimal projection for event route, etc
	| 'init' // first full bootstrap after login
	| 'cities' // after city changes
	| 'topEvents'; // special top events view

// FOUNDATION REQUEST ---
type FoundationRequest = {
	userID: string;
	devID?: string | null; // per device watermark key (server summary)
	deviceID?: string | null; // persistent device row key (for salt/deviceKey)
	gotKey?: boolean; // client says it already has auth material
	clientEpoch?: number | null; // client's auth epoch
	load: FoundationLoadMode;
	cities?: Array<number | { cityID?: number; hashID?: string; lat?: number; lng?: number; city?: string }>;
	getCities?: Array<{ hashID?: string; lat: number; lng: number; city: string; part?: string | null }>;
	lastDevSync?: number | null;
	lastLinksSync?: number | null;
	devIsStable?: boolean | null;
};

// FOUNDATION RESPONSE ---
type FoundationResponse = {
	// AUTH / DEVICE ---
	auth?: string;
	authEpoch?: number;
	authExpiry?: number;
	previousAuth?: string;
	previousEpoch?: number;
	deviceSalt?: { salt: string; deviceKey: string } | null;

	// USER + NOTIFICATIONS ---
	user?: object | null;
	notifDots?: { chats: number; alerts: number; archive: number; lastSeenAlert?: number };

	// SYNC ---
	interactions?: object; // add bundles
	delInteractions?: object; // delete bundles
	devSync?: number;
	linksSync?: number;
	unstableDev?: boolean;

	// PROJECTION ---
	contentMetas?: Array<object>;
	citiesData?: Array<object>;
	contSync?: number;
};
```

---

## Module 1: AuthDeviceSession

```ts
// AUTH DEVICE SESSION ---
// Handles auth rotation and device salt binding.
export class AuthDeviceSession {
	// INIT ---
	constructor({ getAuth, getDeviceSalt, sql }) {
		this.getAuth = getAuth;
		this.getDeviceSalt = getDeviceSalt;
		this.sql = sql;
	}

	// MINT OR REFRESH AUTH ---
	async mintOrRefreshAuth({ userID, gotKey, load, clientEpoch, deviceID }) {
		// GATE ---
		// Only do auth when client lacks key AND mode includes auth.
		const authLoads = new Set(['init', 'fast', 'auth', 'cities', 'topEvents']);
		if (gotKey) return null;
		if (!authLoads.has(load)) return null;

		const authData = this.getAuth(userID, { clientEpoch });
		if (!authData) return null;

		// DEVICE SALT (OPTIONAL) ---
		// Only if we actually minted auth and the client provided deviceID.
		let deviceSalt = null;
		if (deviceID) {
			const con = await this.sql.getConnection();
			try {
				deviceSalt = await this.getDeviceSalt(con, userID, deviceID);
			} finally {
				con.release();
			}
		}

		return {
			auth: authData.auth,
			authEpoch: authData.epoch,
			authExpiry: authData.expiry,
			...(authData.previousAuth ? { previousAuth: authData.previousAuth, previousEpoch: authData.previousEpoch } : {}),
			...(deviceSalt ? { deviceSalt } : {}),
		};
	}
}
```

---

## Module 2: SyncEngine

```ts
// SYNC ENGINE ---
// Handles watermark resolution, delta selection, and persistence.
export class SyncEngine {
	// INIT ---
	constructor({ resolveDeviceSync, persistDeviceSync, syncUserData }) {
		this.resolveDeviceSync = resolveDeviceSync;
		this.persistDeviceSync = persistDeviceSync;
		this.syncUserData = syncUserData;
	}

	// RESOLVE WATERMARKS ---
	async resolveWatermarks({ userID, devID, lastDevSync, lastLinksSync }) {
		// WATERMARK RESOLVE ---
		// Clamp + max(client, stored) to avoid rewinds.
		const devSync = await this.resolveDeviceSync(userID, devID, Number(lastDevSync) || 0);
		const linksSync = Number(lastLinksSync) || 0;
		return { devSync, linksSync };
	}

	// SYNC ---
	async sync({ req, con, userID, load, devID, devSync, linksSync, unstableDevPolicy }) {
		// SYNC DECISION ---
		// Only sync for load modes that need it.
		const syncLoads = new Set(['init', 'fast', 'auth', 'cities', 'topEvents']);
		if (!syncLoads.has(load)) return { interactions: {}, delInteractions: {}, devSync, linksSync, user: null };

		const result = await this.syncUserData(req, con, { userID, load, devID, devSync, linksSync, oldUserUnstableDev: unstableDevPolicy });

		// PERSIST AFTER SUCCESS ---
		// Persist the max watermark so client convergence stays monotonic.
		await this.persistDeviceSync(userID, devID, result.devSync, result.linksSync);

		return result;
	}
}
```

---

## Module 3: ProjectionQuery

```ts
// PROJECTION QUERY ---
// Reads projection (metas) and applies access gates.
export class ProjectionQuery {
	// INIT ---
	constructor({ processContentMetas }) {
		this.processContentMetas = processContentMetas;
	}

	// GET CONTENT METAS ---
	async getContent({ con, load, getCities, cities, userID }) {
		// MODE GATE ---
		// Auth-only can skip projection.
		if (load === 'auth') return { contentMetas: undefined, citiesData: undefined, contSync: Date.now() };
		return await this.processContentMetas({ con, load, getCities, cities, userID });
	}
}
```

---

## Orchestrator: FoundationController

```ts
// FOUNDATION CONTROLLER ---
// Thin composition layer; keeps ordering explicit and failure domains isolated.
export async function FoundationController(req, res, deps) {
	// INPUT ---
	const body = req.body || {};
	const { userID, devID, devIsStable, load, getCities = [], cities = [], gotKey, clientEpoch, deviceID } = body;

	// SAFETY ---
	// This endpoint is the boot spine; always return JSON with safe defaults.
	if (!userID) return res.status(400).json({ error: 'missingUserID' });

	// MODULES ---
	const { authDeviceSession, syncEngine, projectionQuery, alertsService, sql } = deps;

	// AUTH FIRST ---
	// Allows including device salt only when auth is minted.
	const authBundle = await authDeviceSession.mintOrRefreshAuth({ userID, gotKey, load, clientEpoch, deviceID });

	// NOTIFS NON-BLOCKING ---
	let notifDots = { chats: 0, alerts: 0, archive: 0, lastSeenAlert: 0 };
	try {
		notifDots = await alertsService.getNotifDots(userID);
	} catch {}

	// AUTH-ONLY FAST EXIT ---
	if (load === 'auth') {
		return res.json({
			notifDots,
			unstableDev: Boolean(devIsStable === false),
			...(authBundle || {}),
		});
	}

	// CONNECTION (LAZY) ---
	// Only open SQL if required by submodules.
	let con = null;
	try {
		// WATERMARK RESOLVE ---
		const { devSync, linksSync } = await syncEngine.resolveWatermarks({
			userID,
			devID,
			lastDevSync: body.lastDevSync,
			lastLinksSync: body.lastLinksSync,
		});

		// SYNC ---
		const unstablePolicy = Boolean(body.is !== 'newUser' && devIsStable === false);
		const syncResult = await syncEngine.sync({
			req,
			con,
			userID,
			load,
			devID,
			devSync,
			linksSync,
			unstableDevPolicy: unstablePolicy,
		});

		// PROJECTION ---
		// Only now do we compute content metas.
		const projectionResult = await projectionQuery.getContent({
			con,
			load,
			getCities,
			cities,
			userID,
		});

		// ASSEMBLE RESPONSE ---
		return res.json({
			...(authBundle || {}),
			notifDots,
			unstableDev: unstablePolicy,

			user: syncResult.user,
			interactions: syncResult.interactions,
			delInteractions: syncResult.delInteractions,
			devSync: syncResult.devSync,
			linksSync: syncResult.linksSync,

			contentMetas: projectionResult.contentMetas,
			citiesData: projectionResult.citiesData,
			contSync: projectionResult.contSync,
		});
	} catch (e) {
		// ERROR BOUNDARY ---
		// The “best version” should return structured errors for observability.
		return res.status(500).json({ error: 'foundationFailed' });
	} finally {
		if (con) con.release?.();
	}
}
```

---

## What you gain with this structure

-   You can unit-test each module in isolation:
    -   Auth rotation correctness
    -   Watermark monotonicity
    -   Projection privacy gating
-   You can run projection rebuilds independently (tasks) without touching sync/auth.
-   You can evolve the protocol by adding a version field without rewriting the whole loader.
