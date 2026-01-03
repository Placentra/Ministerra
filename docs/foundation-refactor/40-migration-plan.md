# 40 — Migration Plan (From current Foundation to “best version”)

This plan keeps production safe by changing one boundary at a time.

## Phase 0 — Freeze the contract

- Add a “protocol version” field in request/response (even if always `1` initially).
- Add server-side validation for required fields per load mode.
- Write one integration test that snapshots a typical response shape for:
  - `load=auth`
  - `load=init`
  - `load=fast`
  - `load=topEvents`

## Phase 1 — Extract modules behind the current handler

Goal: no behavior change, just structure.

- Create backend modules:
  - `AuthDeviceSession`
  - `SyncEngine`
  - `ProjectionQuery`
- Keep current `foundation.ts` route handler but delegate logic to these modules.

Success condition:
- identical outputs for same inputs (snapshot test passes).

## Phase 2 — Make watermarks formally monotonic

- Ensure all watermark persistence happens only after:
  - deltas have been fetched
  - response is assembled
- Add a property test:
  - repeated calls with same watermark are idempotent
  - watermarks never decrease

## Phase 3 — Split “Projection rebuild” from “Projection query”

Goal: make projection a real bounded context.

- Keep query code in `ProjectionQuery`.
- Move rebuild/streaming code to:
  - `ProjectionRebuilder` (jobs/tasks/boot)
- Define explicit inputs/outputs:
  - Domain writes → emit events → projector updates redis
  - Periodic rebuild can re-hydrate the entire projection

## Phase 4 — Frontend loader refactor

- Wrap current loader in a `FoundationClient`.
- Introduce `DeviceStore` interface (forage) and `Brain` methods.
- Replace incremental “random” writes with explicit:
  - `mergeUser`
  - `applyInteractions`
  - `mergeContentMetas`

Success condition:
- same UX; fewer “mystery” state bugs; faster debugging.

## Phase 5 — Hardening for “cutting-edge”

- Add strict runtime validation for meta arrays (length matches indexes).
- Add tracing spans:
  - auth rotation
  - sync decision
  - SQL delta queries
  - redis pipelines
  - projection assembly
- Add a canary mode:
  - compute new projection in parallel (shadow) and compare counts/hashes


