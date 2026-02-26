# fn-2.6 Document preview architecture and release rollout details

## Description

Publish implementation and operational docs for run identity, auth/proxy constraints, validator evidence policy, and strict rollout behavior.

**Size:** M
**Files:**

- `apps/docs/content/docs/tasks/creating-tasks.mdx`
- `apps/docs/content/docs/tasks/managing-tasks.mdx`
- `apps/docs/content/docs/configuration/environment-setup/sandbox.mdx`
- `apps/docs/content/docs/resources/release-notes.mdx`
- `apps/www/src/lib/constants.ts`

## Approach

- Document `runId` as canonical run identity, immutable `thread_run`, and pointer-only `thread_run_context`.
- Document `thread_ui_validation` scoping by `{threadId,threadChatId}` and why cross-chat collisions are blocked.
- Document explicit run propagation (`startAgentMessage -> sendDaemonMessage -> daemon envelope v2 -> daemon-event route`).
- Document `packages/shared/src/types/preview.ts` as the centralized preview/security enum and claim-type source.
- Document preview session start route + lifecycle (`pending -> initializing -> ready|unsupported|error`), `requiresWebsocket` config semantics, DNS/IP pinning, and terminal revocation/expiration flows.
- Document routing scope explicitly as API-only under `/api/internal/preview/*` and `/api/preview/*` (no new app page routes).
- Document bootstrap token security contract (HS256, `kid`, claims, per-audience key namespaces, replay prevention, fail-closed outage behavior, sustained/burst rate limits, rotation).
- Document key-management internals: namespaced `active_kid`/`prev_kid` pointers, unknown-`kid` behavior, and rotation runbook.
- Document proxy transport and hardening contracts (Node runtime, SSE no-cache streaming headers, WS unsupported behavior, SSRF/open-redirect protections, server-only authHeaders append, origin/referer rewrite, revocation-version checks, `proxyReqId`).
- Document provider-aware pinning modes (`strict_ip`, `provider_asn`, `tls_sni_host`) and DNS A/AAAA/CNAME TTL handling for ngrok/CDN drift.
- Document internal-only v1 constraint: use `strict_ip` + `tls_sni_host` now, defer `provider_asn` until vetted ASN source is available.
- Document preview subscription auth contract (claim tuple binding, expiry, replay handling, connect/fan-out checks, reconnect requires fresh token).
- Document canonical error taxonomy (`code -> HTTP`) and limiter-specific rate-limit error payloads.
- Document validator evidence contract (centralized redaction registry + provider extensions, size caps, hashes, immediate post-upload/read verification, signed URLs, retention lifecycle, pass criteria, hard-timeout kill semantics).
- Document deterministic ready-guard placement and static no-bypass verification strategy.
- Document run-context optimistic-concurrency retry/backoff semantics.
- Document `endSha` mismatch/missing fallback semantics, maintenance backstop behavior, and event ordering/dedupe behavior.
- Document `.terragon/preview-validation.json` schema versioning and missing/invalid behavior.
- Document preemptive cookie-block detection and fallback behavior.
- Document `codesandboxId` alias utility guidance for naming consistency.
- Document route-level feature-flag gating (`404` when preview is disabled) across preview endpoints.
- Document daemon build artifact policy (`packages/daemon/dist/index.js` regenerated from `packages/daemon/src/*` changes).
- Add operational runbooks:
  - quarantine triage and alert thresholds
  - maintenance route auth/signature setup
  - cache invalidation triggers and outage behavior
  - daemon dist parity CI check and adapter contract-test expectations
  - internal emergency bypass policy for replay-store outages (scope, audit logging, rollback)
- Add release notes entry and bump `RELEASE_NOTES_VERSION`.

## Acceptance

- [ ] Docs cover all security-critical contracts (auth, proxy, cache, maintenance route auth).
- [ ] Docs cover fail-closed outage semantics, revocation-version checks, and key-namespace separation.
- [ ] Docs explain strict-vs-legacy daemon behavior and rollout phases.
- [ ] Docs explain immutable run storage (`thread_run`) vs active pointer context (`thread_run_context`).
- [ ] Docs include validation evidence policy and artifact handling constraints.
- [ ] Docs include guard/state-machine behavior, static no-bypass verification, and troubleshooting flows.
- [ ] Docs call out API-only preview routing scope and centralized shared preview/security types.
- [ ] Docs include `.terragon/preview-validation.json` schema versioning and missing/invalid behavior.
- [ ] Docs include keystore rotation + adapter contract coverage expectations for operations/on-call.
- [ ] Docs capture internal-only rollout boundaries (Daytona-first, deterministic E2B unsupported behavior, deferred ASN mode).
- [ ] Release note + version bump are included.

## Test matrix

- Docs QA: verify examples use canonical `runId` naming only.
- Docs QA: verify unsupported reasons and event names match enum/versioned contract.
- Docs QA: verify unsupported reasons distinguish `adapter_unimplemented` and `capability_missing`.
- Docs QA: verify propagation path and lifecycle transition examples match implemented routes.
- Docs QA: verify docs do not imply new app page routes for preview and instead reference `/api/internal/preview/*` + `/api/preview/*`.
- Docs QA: verify docs specify route-level `sandboxPreview` gating with `404` behavior and fresh-token reconnect policy.
- Docs QA: verify error-code to HTTP mapping and limiter payload examples match contracts.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
