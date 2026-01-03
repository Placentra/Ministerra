# 00 — Overview (What changes, what stays)

This refactor keeps your current “Foundation” product behavior but changes _structure_:

## What stays the same (externally)

-   The client calls a single endpoint like `POST /foundation`.
-   Response can include (depending on mode):
    -   auth rotation info
    -   device salt/keys (when needed)
    -   user profile (optionally)
    -   interactions + deletions deltas
    -   notif dots
    -   content metas for requested cities / top events
    -   sync watermarks

## What changes (internally)

Instead of one large module that “does everything”, the backend becomes 3 bounded subsystems:

1. **Auth/Device Session**

    - Auth rotation epochs
    - Device binding (deviceID → deviceKey/salt)
    - Refresh semantics

2. **Sync Engine**

    - Watermark resolution (`resolveDeviceSync`)
    - Delta table reads / fallback modes
    - Writes back watermarks only after successful delivery

3. **Projection Query**
    - Reads the prebuilt projection (Redis metas + cityFiltering)
    - Applies permission gates efficiently (blocks/links/trusts/invites)
    - Returns a structured “content metas bundle”

Then **Foundation Orchestrator** composes those 3 into a single response.

## Why this is “cutting-edge potential”

You already have these winning elements:

-   Projection/read-model in Redis (fast feed reads)
-   Compact meta arrays (dense data, fast filters)
-   Watermark delta sync (mobile/web scale)
-   Ability to do auth-only refresh

The refactor makes it “excellent” by adding:

-   explicit contracts
-   isolated responsibilities
-   testable invariants
-   predictable evolution paths
