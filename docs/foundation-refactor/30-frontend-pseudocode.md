# 30 — Frontend Pseudocode (Best Version)

This models a refactored “foundation loader” in a way that is **deterministic**, **testable**, and less coupled to global mutable state.

Key idea:

-   Keep “brain” as state storage, but put the loader logic behind an explicit `FoundationClient`.
-   Treat device storage as a repository (`DeviceStore`) with clear read/write semantics.

```ts
// DEVICE STORE ---
// Wraps IndexedDB/localforage + sessionStorage/localStorage.
class DeviceStore {
	// LOAD CACHE SNAPSHOT ---
	async loadSnapshot() {
		// STORAGE LOAD ---
		// Reads: miscel/user/events/users/auth/alerts etc.
		return {
			miscel: await forage.get('miscel'),
			user: await forage.get('user'),
			alerts: await forage.get('alerts'),
			token: await forage.get('token'),
			auth: await forage.get('auth'),
		};
	}

	// SAVE AUTH MATERIAL ---
	async saveAuth({ userID, auth, epoch, prevAuth, deviceSalt, deviceKey, print, pdk }) {
		// AUTH SAVE ---
		// This mirrors your current “forage worker” logic but with an explicit API.
		await forage.set('auth', { auth, epoch, prevAuth, deviceSalt, deviceKey, print, pdk }, userID);
	}

	// SAVE USER STATE ---
	async saveUser(user) {
		await forage.set('user', user);
	}
}

// FOUNDATION CLIENT ---
class FoundationClient {
	constructor({ axios, deviceStore }) {
		this.axios = axios;
		this.deviceStore = deviceStore;
	}

	// BUILD REQUEST ---
	buildRequest({ route, uiIntent, localState }) {
		// PLAN BUILD ---
		// Decide load mode deterministically.
		const load = uiIntent === 'topEvents' ? 'topEvents' : route.startsWith('/event/') ? 'fast' : localState.needsCitiesChange ? 'cities' : localState.isFirstInit ? 'init' : 'auth';

		return {
			load,
			userID: localState.userID,
			gotKey: localState.gotKey,
			clientEpoch: localState.clientEpoch,
			devID: localState.devID,
			deviceID: localState.deviceID,
			devIsStable: localState.devIsStable,
			lastDevSync: localState.lastDevSync,
			lastLinksSync: localState.lastLinksSync,
			cities: localState.citiesToFetch,
			getCities: localState.cityObjectsToResolve,
		};
	}

	// LOAD ---
	async loadFoundation({ brain, route, uiIntent }) {
		// HYDRATE LOCAL SNAPSHOT ---
		const snapshot = await this.deviceStore.loadSnapshot();
		brain.hydrate(snapshot); // pure merge, no side effects besides brain mutation

		// BUILD REQUEST ---
		const req = this.buildRequest({ route, uiIntent, localState: brain.toFoundationLocalState() });

		// NETWORK CALL ---
		const response = (await this.axios.post('/foundation', req)).data || {};

		// APPLY AUTH ---
		if (response.auth) {
			await this.deviceStore.saveAuth({
				userID: brain.user.id,
				auth: response.auth,
				epoch: response.authEpoch,
				prevAuth: response.previousAuth,
				deviceSalt: response.deviceSalt,
				deviceKey: response.deviceKey,
				print: getDeviceFingerprint(),
				pdk: getPDK(), // only in login flow
			});
		}

		// APPLY SYNC ---
		if (response.user) brain.mergeUser(response.user);
		if (response.interactions) brain.applyInteractions(response.interactions);
		if (response.delInteractions) brain.applyInteractionDeletes(response.delInteractions);

		// APPLY PROJECTION ---
		if (response.contentMetas) brain.mergeContentMetas(response.contentMetas, response.contSync);
		if (response.citiesData) brain.mergeCitiesData(response.citiesData);

		// APPLY NOTIFS ---
		if (response.notifDots) brain.user.alerts.notifDots = response.notifDots;

		// PERSIST CRITICALS ---
		await this.deviceStore.saveUser(brain.user);

		return brain;
	}
}
```

## The “new programming mode” on frontend

Instead of dozens of implicit mutations spread around:

-   “Brain” becomes a **state container** with explicit methods:

    -   `hydrate(snapshot)`
    -   `toFoundationLocalState()`
    -   `mergeUser(user)`
    -   `applyInteractions(add)`
    -   `applyInteractionDeletes(del)`
    -   `mergeContentMetas(bundle, contSync)`

-   The loader becomes one orchestrator:
    -   `FoundationClient.loadFoundation(...)`

That’s the shape that makes it maintainable.
