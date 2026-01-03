# 10 — Backend Architecture (Boundaries + contracts)

## Bounded contexts/modules

### `AuthDeviceSession`

Responsibilities:

-   Rotate auth material by epoch (your current `getAuth` logic).
-   Bind deviceID → `{deviceSalt, deviceKey}` (your current `user_devices` logic).
-   Return “previous epoch auth” for smooth client transitions.

Public API:

-   `mintOrRefreshAuth({ userID, clientEpoch, gotKey, deviceID }) -> AuthBundle | null`
-   `maybeLoadDeviceSalt({ userID, deviceID, needsDeviceSalt }) -> DeviceSaltBundle | null`

Invariants:

-   Never emit auth unless server intends to rotate/refresh.
-   If emitting rotated auth and deviceID is present, include device salt/key info if needed for client decrypt.

---

### `SyncEngine`

Responsibilities:

-   Resolve watermarks safely (clamp + max(client, server)).
-   Decide which tables to sync based on load mode and watermarks.
-   Fetch deltas (or full snapshot) and return:
    -   `interactionsAdd`
    -   `interactionsDel`
    -   `updatedDevSync`
    -   `updatedLinksSync`
-   Persist watermarks only after successful assembly/response.

Public API:

-   `resolveWatermarks({ userID, devID, clientDevSync, clientLinksSync }) -> { devSync, linksSync }`
-   `syncUserState({ con, userID, loadMode, devID, devSync, linksSync, unstableDevicePolicy }) -> SyncBundle`
-   `persistWatermarks({ userID, devID, devSync, linksSync }) -> void`

Invariants:

-   Never “advance” a watermark unless the payload that corresponds to it is actually produced.
-   Delta reads must be idempotent and monotonic (no rewinds).

---

### `ProjectionQuery`

Responsibilities:

-   Return a “Content Metas Bundle” for requested cities:
    -   `cityMetas` (private)
    -   `cityPubMetas` (public)
    -   `cityFiltering` (gate index)
-   Apply access rules using:
    -   blocks (always)
    -   links/trusts/invites (when needed)
-   Provide `contSync` stamp used by client to decide staleness.

Public API:

-   `getContentMetas({ loadMode, cities, getCities, userID, con }) -> ContentMetasBundle`
-   `getTopEventsMetas({ userID }) -> ContentMetasBundle`

Invariants:

-   Public metas still respect blocks.
-   Individual privacy (“ind”) attendance filtering is enforced consistently.

---

### `FoundationOrchestrator`

Responsibilities:

-   Compose the three subsystems into one response:
    -   auth bundle (optional)
    -   notif dots (optional but non-blocking)
    -   sync bundle (optional by load mode)
    -   content metas bundle (optional by load mode)

Public API:

-   Express/HTTP handler only.

Invariants:

-   Must be resilient: if non-critical parts fail (notif dots), do not fail whole bootstrap.
-   Must keep ordering explicit:
    -   auth first (so device salt decision can be made)
    -   watermark resolve before sync
    -   persist watermarks only after sync success
