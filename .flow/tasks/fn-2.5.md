# fn-2.5 Add daemon correlation quarantine, cache semantics, and event telemetry

## Description

Harden run correlation and security posture with strict/legacy daemon handling, explicit cache behavior, and schema-locked telemetry.

**Size:** M
**Files:**

- `packages/daemon/src/shared.ts`
- `packages/daemon/dist/index.js` (generated via build from `packages/daemon/src/*`)
- `apps/www/src/agent/msg/startAgentMessage.ts`
- `apps/www/src/agent/msg/send-daemon-message.ts`
- `apps/www/src/server-lib/handle-daemon-event.ts`
- `apps/www/src/agent/sandbox.ts`
- `apps/www/src/server-lib/preview-auth.ts`
- `apps/www/src/server-lib/preview-observability.ts`
- `packages/shared/src/types/preview.ts`

## Approach

- Implement explicit `runId` propagation path:
  - `startAgentMessage` receives minted `runId`
  - `sendDaemonMessage` includes `runId` in daemon start payload
  - daemon envelope v2 echoes `runId` + `eventId` + `seq` on every flush
  - daemon-event route validates/binds runId before mutation
- Keep daemon source-of-truth in `packages/daemon/src/*`; regenerate `packages/daemon/dist/index.js` from build output after envelope contract changes.
- Expand daemon envelope v2 to require `runId` on normal flows and `endSha` on terminal events.
- Enforce payload-version negotiation per run start and quarantine mixed v1/v2 envelopes for the same `runId`.
- Implement strict/legacy policy using frozen run-context flag snapshot:
  - strict=false: record `legacy_mode` quarantine; mark validation `inconclusive` when UI rules matched (otherwise `not_required`)
  - strict=true: quarantine mismatch/missing runId, return 202 ack, no state mutation
- Clarify terminal `endSha` behavior:
  - terminal event without `endSha` quarantines and acks `202`
  - on terminal event, compare `endSha` with live sandbox HEAD
  - mismatch/head-read failure forces `diffSource='working-tree-fallback'`
  - maintenance backstop (1-minute cron sweep) finalizes stale runs missing terminal `endSha` so active runs do not hang forever
- Audit `apps/www/src/agent/sandbox.ts` read/write boundaries for HEAD lookup paths: sandbox helpers are read-only for run correlation and never mutate run context rows.
- Persist quarantine rows with payload controls:
  - `payloadPrefix2k`
  - `payloadHash`
  - oversized payload offloaded via `payloadR2Key`
  - per-repo sampling/rate-limit for oversized offload during storm conditions
- Enforce event ordering/dedupe:
  - duplicate `eventId` is idempotent no-op
  - out-of-order `seq` is ignored deterministically
- Emit required metrics/events on quarantine and denied access with alertable thresholds.
- Emit explicit counters `strict_mismatch`, `legacy_mode`, and `missing_end_sha` with repo/user/provider dimensions and alert hooks.
- Emit metrics with `preview.*` namespace (`preview.strict_mismatch`, `preview.legacy_mode`, `preview.missing_end_sha`) to keep telemetry naming consistent.
- Implement access cache contract:
  - key `terragon:v1:preview:repo-access:{env}:{userId}:{repoFullName}`
  - TTL `min(60s, previewSessionTTLSeconds)` and negative TTL 5s
  - forced invalidation on team membership and repo visibility changes plus existing triggers
  - all invalidations route through one helper `invalidateRepoAccess(userId, repoFullName, reason)`
  - failure semantics: fail-closed for proxy/exchange/subscription-token paths
- Lock observability event schema (`schemaVersion`, `origin`, `tsServer`, `traceId`, run/session identifiers, `proxyReqId` where applicable).
- Enforce alias utility guidance for `codesandboxId` naming (`sandboxInstanceId` aliases only through shared conversion utilities, never ad-hoc).
- Import preview/security reasons + event enums from `packages/shared/src/types/preview.ts` so denied/quarantine reason values cannot drift.

## Acceptance

- [ ] Daemon runId propagation is explicit and end-to-end (`startAgentMessage -> sendDaemonMessage -> envelope v2 -> daemon-event route`).
- [ ] Quarantine behavior is deterministic and observable for both strict and legacy modes.
- [ ] Payload version negotiation prevents mixed-envelope mutation for a single run.
- [ ] Terminal `endSha` mismatch/missing paths reliably fall back to `working-tree-fallback` with maintenance backstop.
- [ ] Event ordering and dedupe behavior is deterministic for duplicate `eventId` and out-of-order `seq`.
- [ ] Cache key/TTL/invalidation/error semantics are implemented exactly.
- [ ] Oversized quarantine payloads avoid hot-row bloat via R2 pointer.
- [ ] Preview events include required schema fields and versioning.
- [ ] Quarantine retention and purge behavior are explicit (30-day row retention with pre-purge aggregate emission).
- [ ] Metrics naming and dimensions are consistent under `preview.*` namespace.
- [ ] `apps/www/src/agent/sandbox.ts` boundary audit confirms read-only run-correlation usage.
- [ ] `codesandboxId` alias handling remains consistent via shared conversion utilities.
- [ ] `packages/daemon/dist/index.js` is regenerated from source changes (no manual dist edits).

## Test matrix

- Unit: strict/legacy branch behavior by frozen flag snapshot.
- Integration: quarantine insertion + 202 ack + no retry storm behavior.
- Integration: daemon event dedupe coverage verifies duplicate `eventId` does not double-apply state or writes.
- Integration: daemon event ordering coverage verifies out-of-order `seq` is ignored and logged once.
- Integration: terminal `endSha` mismatch path sets `diffSource='working-tree-fallback'`.
- Integration: maintenance backstop finalizes missing-`endSha` stale runs.
- Integration: mixed envelope versions for one run are quarantined and do not mutate state.
- Unit: cache fail-closed behavior across proxy/exchange/subscription and negative-TTL semantics.
- Unit: invalidation helper is the only cache-invalidation write path and records reason.
- Unit: event payload schema validation and required field enforcement.
- Unit: metric names are `preview.*` namespaced and include required dimensions.
- Unit: strict=false + UI-rule-match path resolves `inconclusive` (not `not_required`).
- Unit: `codesandboxId` alias utility maintains canonical naming consistency.
- Build/integration: daemon source-envelope changes regenerate `packages/daemon/dist/index.js` with parity checks.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
