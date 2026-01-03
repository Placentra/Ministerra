# Foundation Refactor (Best-Version Blueprint)

This folder is a **pseudocode + guide** for refactoring the existing Foundation system into a clearer, safer, more scalable architecture.

The goal is to keep the strengths you already have:

-   One “bootstrap” endpoint returning _auth + deltas + content projection_ in few roundtrips
-   Watermark-based delta sync (`devSync` / `linksSync` / per-device summary keys)
-   Projection layer (Redis metas) for fast feed loads
-   Unstable device fallback behavior

…but remodel it so each concern has explicit boundaries, contracts, and testable invariants.

## How to read this

-   Start here: `00-overview.md`
-   Then backend architecture: `10-backend-architecture.md`
-   Then backend pseudocode (the “new programming mode”): `20-backend-pseudocode.md`
-   Then frontend loader pseudocode: `30-frontend-pseudocode.md`
-   Then migration plan: `40-migration-plan.md`

## What “best version” means here

-   **Core domain writes** happen to SQL and emit domain events.
-   **Projections** (Redis metas / city indexes / “topEvents”) are built by a projection service consuming domain events _and/or_ periodic rebuild jobs.
-   The “Foundation” HTTP endpoint becomes a **thin orchestrator** that composes:
    -   Auth/Device Session
    -   Sync Engine
    -   Content Projection Query

## Key design rule (important)

The refactor is successful if you can:

-   change projection internals without touching auth/sync logic
-   change auth rotation without touching content metas logic
-   change sync delta tables without touching projection code
