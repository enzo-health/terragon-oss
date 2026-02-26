# Sandbox Preview Sessions With Human + Agent Browser Validation

## Problem

Terragon needs trustworthy app previews from the exact sandbox where the agent worked, with human verification and agent-generated UI validation evidence before PR ready transitions.

## Scope

- Internal-only rollout.
- Manual preview start for humans.
- Auto-validation for UI-change runs.
- Daytona first; E2B may return unsupported for preview until adapter parity.

## Current baseline vs planned implementation

Baseline in current code (pre-fn-2 implementation):

- `packages/shared/src/db/schema.ts` does not yet define `thread_run`, `thread_run_context`, `preview_session`, `preview_validation_attempt`, `daemon_event_quarantine`, or `thread_ui_validation`.
- `apps/www/src/app/api` does not yet include preview handlers under `/api/internal/preview/*` or `/api/preview/*`.
- `apps/www/src/app/**/page.tsx` does not have preview-dedicated page routes.

Planned implementation mapping:

- `fn-2.1`: run tables, canonical writers, feature flag definitions wiring (`packages/shared/src/model/feature-flags-definitions.ts`), and shared preview/security enum/type source (`packages/shared/src/types/preview.ts`).
- `fn-2.2`: preview API handlers, exchange/proxy rate limiting in `apps/www/src/lib/rate-limit.ts`, and preview channel auth fan-out enforcement in `apps/broadcast/src/auth.ts` and `apps/broadcast/src/server.ts`.
- `fn-2.4`: validator routes/evidence writes and ready-guard enforcement on all ready-entry points.
- `fn-2.5`: daemon envelope/run-correlation hardening plus `packages/daemon/dist/index.js` regeneration from source build outputs.

## Routing scope

- Preview work in fn-2 is API-only under `/api/internal/preview/*` and `/api/preview/*`.
- No new app page routes (`apps/www/src/app/**/page.tsx`) are part of this epic.

## Canonical identity

Use `runId` everywhere. Do not introduce `runAttemptId` as a second identity.

`runId` is the only run correlation key for:

- daemon envelopes
- DB rows (`thread_run`, `preview_session`, `preview_validation_attempt`, `thread_ui_validation`)
- observability events
- ready-guard decisions

## Centralized preview/security types

- `packages/shared/src/types/preview.ts` is the canonical source for preview lifecycle enums, unsupported/security reasons, preview event names, and auth claim tuple types.
- `apps/www`, `apps/broadcast`, and daemon-facing code must import these shared definitions to avoid enum drift.
- `packages/types/src/broadcast.ts` composes transport schemas from this shared source.

## Data contract (explicit tables)

### `thread_run` (new, immutable per run)

Primary key: `runId`
Columns:

- `threadId`, `threadChatId`
- `startRequestId`
- `triggerSource`
- `status` enum: `booting|running|validating|finished|failed`
- `codesandboxId`
- `sandboxProvider`
- `runStartSha`
- `runEndSha`
- `frozenFlagSnapshotJson` (`sandboxPreview`, `daemonRunIdStrict`, rollout phase)
- `terminalEventId` (nullable, for terminal-event dedupe)
- `lastAcceptedSeq` (nullable, monotonic daemon sequence checkpoint)
- `startedAt`, `endedAt`
- timestamps

Indexes/constraints:

- unique `{threadId,threadChatId,startRequestId}` (idempotent start requests)
- partial unique active index on `{threadId,threadChatId}` where `status in ('booting','running','validating')` (implemented via raw SQL migration; Drizzle schema references the index name)
- partial unique terminal dedupe on `{runId,terminalEventId}` where `terminalEventId is not null`
- index on `{threadId,threadChatId,createdAt desc}`

### `thread_run_context` (new, active pointer only)

Primary key: `{threadId, threadChatId}`
Columns:

- `activeRunId`
- `activeCodesandboxId`
- `activeSandboxProvider`
- `activeStatus` enum: `booting|running|validating|finished|failed`
- `version` (int, optimistic concurrency token)
- `activeUpdatedAt`
- timestamps

Indexes/constraints:

- index on `activeRunId`

### `preview_session` (new)

Primary key: `previewSessionId`
Columns:

- `threadId`, `threadChatId`, `runId`
- `userId` (nullable only for server validation actor)
- `codesandboxId`, `sandboxProvider`
- `repoFullName`
- preview config snapshot (`command`, `port`, `healthPath`, `requiresWebsocket`, `openMode`)
- `upstreamOrigin` (signed and server-written only)
- `pinnedUpstreamIpsJson` (server-written at session start with `{addressesV4,addressesV6,cnameChain,ttlSeconds,resolvedAt,pinningMode}`; enforced on every proxy hop)
- `revocationVersion` (int, increment on revoke/rebind/security events)
- `lastDnsCheckAt` (nullable timestamp, for TTL refresh enforcement)
- `dnsRefreshedOnce` (boolean, default false)
- `state` enum: `pending|initializing|ready|unsupported|expired|revoked|error`
- `unsupportedReason` enum: `missing_config|adapter_unimplemented|ws_required|frame_bust|capability_missing|cookie_blocked|proxy_denied`
- `expiresAt`, `revokedAt`, timestamps

Indexes/constraints:

- index on `{runId,createdAt desc}`
- index on `{threadId,createdAt desc}`

### `preview_validation_attempt` (new)

Primary key: `{threadId, runId, attemptNumber}`
Columns:

- `status` enum: `pending|running|passed|failed|inconclusive|unsupported`
- `command`, `exitCode`, `durationMs`
- `diffSource` enum: `sha|working-tree-fallback`
- `diffSourceContextJson` (mismatch/lookup failure details for fallback reasoning)
- artifact keys: `stdoutR2Key`, `stderrR2Key`, `traceR2Key`, `screenshotR2Key`, `videoR2Key`
- artifact hashes: `stdoutSha256`, `stderrSha256`, `traceSha256`, `screenshotSha256`, `videoSha256`
- artifact sizes (bytes)
- `videoUnsupportedReason`
- `matchedUiRulesJson`
- timestamps
- `attemptNumber` is 1-based (1..3) and immutable per row

Indexes:

- index on `runId`

### `daemon_event_quarantine` (new)

Primary key: `id`
Columns:

- `threadId`, `threadChatId`, `runIdOrNull`, `activeRunId`
- `reason` enum: `missing_run_id|mismatch|legacy_mode`
- `payloadHash`
- `payloadPrefix2k` (first 2KB)
- `payloadR2Key` (nullable pointer for oversized payload)
- timestamps

Indexes:

- index on `{threadId,createdAt desc}`

### `thread_ui_validation` (new)

Primary key: `{threadId, threadChatId}`
Columns:

- `latestRunId`
- `uiValidationOutcome` enum: `not_required|pending|passed|failed|inconclusive|blocked`
- `readyDowngradeState` enum: `not_attempted|converted_to_draft|conversion_failed|not_supported`
- `readyDowngradeLastAttemptAt`
- `blockingReason`
- timestamps

## Canonical writers and race handling

Only these write run context identity:

- `createRunContext({threadId,threadChatId,startRequestId,triggerSource})`
- `bindRunSandbox({threadId,threadChatId,runId,codesandboxId,sandboxProvider})`

Required transaction contract:

1. `SELECT ... FOR UPDATE` existing `thread_run_context` row by `{threadId,threadChatId}`.
2. If `thread_run` already has `{threadId,threadChatId,startRequestId}`, return that existing `runId` (idempotent).
3. If a different active run exists, mark prior `thread_run.status='finished'`, set `endedAt`, and update pointer row.
4. Mint `runId`, insert immutable `thread_run` row with `status='booting'` and frozen flags snapshot.
5. Upsert `thread_run_context` pointer to `{activeRunId,activeStatus='booting',version=previous+1}` only via compare-and-swap (`... where version = expectedVersion`) in the same transaction.
6. `lastAcceptedSeq` updates always use DB CAS (`update ... set lastAcceptedSeq = :seq where lastAcceptedSeq is null or lastAcceptedSeq < :seq`) to prevent race regressions.

Version conflict retry contract:

- on optimistic conflict, retry up to 5 attempts with exponential backoff (`25ms * 2^attempt`) and jitter (+/-20%)
- if all retries fail, return deterministic conflict result (no partial run-context writes)

Write boundary:

- immutable run facts (`startRequestId`, flags snapshot, SHAs, terminal dedupe fields) live only in `thread_run`
- mutable "current run for chat" pointer lives only in `thread_run_context`

Start request sources (required):

- UI/new run: action-layer UUID
- retry: retry action UUID
- follow-up queue: queue message ID
- scheduled automation: invocation ID
- slash command: slash request UUID

## RunId mint + propagation path

Required hop-by-hop contract:

1. `startAgentMessage` calls `createRunContext(...)`, which mints `runId`, writes `thread_run`, and returns `{runId, frozenFlagSnapshot}`.
2. `startAgentMessage` passes `runId` into `sendDaemonMessage` for the daemon start payload.
3. `sendDaemonMessage` serializes `runId` into the daemon start envelope (`payloadVersion=2` path only).
4. Daemon echoes `runId` on every flush group envelope (`eventId`, `seq`, `payloadVersion=2`).
5. `daemon-event` route (`handleDaemonEvent`) rejects strict-mode mismatches, dedupes, and writes terminal state back to `thread_run` and `thread_run_context`.

## Daemon envelope + propagation contract

### Envelope v2

All daemon flush groups must include:

- `payloadVersion=2`
- `eventId`
- `seq`
- `runId`
- `endSha` (required on terminal `done|failed|stopped` event)

Event ordering/dedupe rules:

- `eventId` is globally unique per daemon flush; duplicate `eventId` is no-op (ack 202, no state mutation)
- `seq` must be monotonic increasing per `{threadId,threadChatId,runId}`; out-of-order/older `seq` is ignored (ack 202)
- terminal transitions are idempotent via `thread_run.terminalEventId`
- daemon and server negotiate payload version at run start; mixed v1/v2 envelopes for one `runId` are quarantined (`reason='payload_version_mismatch'`) and never mutate state

### Strict vs legacy behavior

Feature flags:

- `sandboxPreview`
- `daemonRunIdStrict`

Enforcement uses frozen run snapshot from `thread_run`.

When `daemonRunIdStrict=false`:

- missing `runId` is accepted as `legacy_mode`
- insert `daemon_event_quarantine` row with `reason='legacy_mode'`
- if UI rules matched changed files, set validation outcome `inconclusive` (do not silently mark `not_required`)
- set validation outcome `not_required` only when no UI rule matches

When `daemonRunIdStrict=true`:

- missing or mismatched `runId` inserts quarantine row and returns `202` ack (no daemon retry storm)
- event is ignored for state mutation
- emit counters `strict_mismatch`, `legacy_mode`, and `missing_end_sha` (dimensioned by repo/user/provider), plus `v1.preview.access.denied` if active preview is impacted
- missing `endSha` on terminal event is quarantined as invalid terminal payload (ack `202`, no terminal mutation)
- maintenance backstop (cron every 1 minute) marks stale runs with missing terminal `endSha` as timed-out terminal (`failed` + `missing_end_sha_timeout`) so run state cannot hang indefinitely

## Preview runtime config contract

Preview startup requires explicit config (no heuristics in v1):

- `preview.command`
- `preview.port`
- `preview.healthPath`
- `preview.requiresWebsocket` (boolean, authoritative for ws-required handling)
- optional `preview.openMode` (`iframe|new_tab`)

Constants:

- `previewSessionTTLSeconds = 1800`
- invalid config => state `unsupported` with reason `missing_config`

## Preview session start contract

Route: `POST /api/internal/preview/session/start`

Request body:

- `threadId`
- `threadChatId`
- `runId`
- optional `openMode` override (`iframe|new_tab`)

Lifecycle transitions:

- `pending` (row inserted with config snapshot + run binding)
- `initializing` (capability probe + tunnel bring-up in progress)
- terminal:
  - `ready` (tunnel healthy, `upstreamOrigin` persisted, cookie exchange enabled)
  - `unsupported` (deterministic `unsupportedReason`)
  - `error` (unexpected startup failure with `errorCode`)

Route behavior:

1. If `sandboxPreview` is disabled, return `404` (route-level gating, no partial behavior).
2. Verify caller access, then verify `{threadId,threadChatId,runId}` equals active pointer binding.
3. Insert `preview_session(state='pending', revocationVersion=1)` and emit `v1.preview.session.state_changed`.
4. Transition to `initializing`, call `getPreviewSupport()`, `probeCapabilities()`, `openPreviewTunnel({port})`.
5. Resolve and persist `pinnedUpstreamIpsJson` from `upstreamOrigin` DNS answers at session start (A/AAAA + CNAME chain + TTL); reject private/loopback targets.
6. Persist provider-aware pinning mode on session row:
   - v1 rollout allows only `strict_ip` and `tls_sni_host` (internal-only rollout)
   - `provider_asn` is deferred until vetted ASN data source is integrated
   - for ngrok/CDN-style providers in v1, enforce trusted provider domain/CNAME suffix anchors with `tls_sni_host`
7. Persist signed `upstreamOrigin`, `expiresAt`, and `state=ready` or mapped `unsupported/error`.
8. Later lifecycle: `ready -> expired|revoked` only via maintenance/revocation paths, with `revocationVersion` incremented on revoke/rebind.
9. Emit `state_changed` for every transition in-order.

Signed upstream origin contract:

- origin signature uses namespace `terragon:v1:preview:keys:origin:*`
- signed payload includes `{scheme,host,port,pinningMode,exp,previewSessionId,revocationVersion}`
- proxy validates signature and claim binding on every request

## Sandbox provider contract (non-breaking)

Add optional preview support object:

- `ISandboxSession.getPreviewSupport(): ISandboxPreviewSupport | null`

`ISandboxPreviewSupport`:

- `probeCapabilities(): { playwright: { browsers: string[]; screenshot: boolean; video: boolean; healthcheck: boolean }, network: { sse: boolean; websocket: boolean } }`
- `openPreviewTunnel({port}) -> {upstreamBaseUrl, authHeaders, expiresAt}`
- `closePreviewTunnel()`
- `runCommandResult() -> {stdout,stderr,exitCode,durationMs}`
- `readFile(path) -> Uint8Array`
- `captureScreenshot()`
- `captureVideo()` or unsupported reason

Scheduling guard:

- validation attempts are only scheduled when `probeCapabilities().playwright.healthcheck=true`
- `getPreviewSupport() === null` maps to `unsupportedReason='adapter_unimplemented'`
- `preview.requiresWebsocket=true` is authoritative for ws-required routing; if proxy/websocket transport is unavailable, set `unsupportedReason='ws_required'` and force `openMode='new_tab'` before iframe render

## Preview auth flow (no query token auth)

### Bootstrap exchange

Route: `POST /api/preview/session/:previewSessionId/exchange`

Token format:

- JWT HMAC-SHA256 (`alg=HS256`)
- header includes `kid`
- key namespace/audience separation is mandatory:
  - exchange token: `iss='terragon-preview'`, `aud='preview-session-exchange'`, key namespace `terragon:v1:preview:keys:exchange:*`
  - broadcast token: `iss='terragon-preview'`, `aud='preview-session-broadcast'`, key namespace `terragon:v1:preview:keys:broadcast:*`
  - proxy cookie token: `iss='terragon-preview'`, `aud='preview-session-cookie'`, key namespace `terragon:v1:preview:keys:cookie:*`
- key rotation: active key + previous key accepted for 15 minutes within the same namespace only
- namespace pointers are explicit:
  - `terragon:v1:preview:keys:{namespace}:active_kid`
  - `terragon:v1:preview:keys:{namespace}:prev_kid`
  - unknown `kid` is rejected and audited
- keys and pointers are centralized in Redis and accessed through one shared preview-key module used by both `apps/www` and `apps/broadcast`

Required claims:

- `iss='terragon-preview'`
- `aud='preview-session-exchange'`
- `iat`, `exp` (TTL max 300s)
- `jti` (UUID)
- `nonce`
- `previewSessionId`, `threadId`, `threadChatId`, `runId`, `userId`, `codesandboxId`, `sandboxProvider`

Validation rules:

- clock skew tolerance: +/-60s
- server startup checks Redis time drift before mint/verify; if skew exceeds grace, minting is disabled and alert emitted
- verify claim binding against DB session row
- replay prevention: Redis `SET NX EX` for both keys:
  - `terragon:v1:preview:exchange:jti:{jti}`
  - `terragon:v1:preview:exchange:nonce:{nonce}`
- if replay store is unavailable, exchange fails closed (`503`) rather than bypassing anti-replay checks
- `503` replay/capacity responses include deterministic JSON `{code,retryAfterMs,backoffHint}` and `Retry-After` when available
- rate limits:
  - session start (`/api/internal/preview/session/start`): sustained `30/min` per `userId`, burst `10/10s`; sustained `120/min` per IP, burst `30/10s`
  - exchange: sustained `60/min` per `userId`, burst `20/10s`; sustained `240/min` per IP, burst `60/10s`
  - proxy: sustained `1200/min` per `previewSessionId`, burst `240/10s`; sustained `3600/min` per IP, burst `600/10s`
- limiter errors must return which limiter tripped (`user|ip|session`) plus `nextAllowedAt`
- exchange fail-closed outage path returns deterministic `503` and allows internal emergency bypass flag for operators in non-external rollout
- IP derivation for per-IP limits uses shared `getClientIp()` policy:
  - prefer `x-vercel-ip`
  - fallback to first `x-forwarded-for`
  - fallback to runtime remote address
  - all policy decisions logged with source label

### Cookie

- cookie value is a server-signed preview token (`aud='preview-session-cookie'`) bound to `{previewSessionId,threadId,threadChatId,runId,userId,revocationVersion}`
- `HttpOnly`, `Secure`
- `Path=/api/preview/proxy/:previewSessionId`
- no `Domain` attribute (host-only cookie)
- `SameSite=None` for iframe mode, `SameSite=Lax` for new-tab mode
- `Max-Age=1800`
- cookie TTL derives from `previewSessionTTLSeconds` (single source of truth)
- proxy validates cookie `revocationVersion` against DB on every request; mismatch clears cookie and denies access
- cookie mint/revocation writes are transactional: increment/check DB `revocationVersion` before issuing cookie, then mint with the committed version only
- mode switches must clear stale cookie path variants and rewrite with the active mode attributes

## Catchall preview proxy contract

Route:

- `/api/preview/proxy/:previewSessionId/:path*`

Runtime requirements:

- `export const runtime = 'nodejs'`
- `export const dynamic = 'force-dynamic'`
- route-level feature flag gating: return `404` when `sandboxPreview` is disabled
- SSE proxying uses Node `http/https` streamed piping with keepalive agent semantics; no fetch-body buffering for long-lived streams

v1 transport support:

- HTTP + SSE pass-through
- WS upgrade unsupported: `501` with JSON payload `{code:'ws_required'}` (and optional retry hint)

Path and origin hardening:

- reject absolute URLs (`scheme://`, `//`)
- normalize path to POSIX separators before routing
- decode at most two passes; reject surviving `.`/`..` or encoded dot-segments after canonicalization
- reject backslash path separators at all stages
- target URL origin must exactly equal server-signed `upstreamOrigin`
- client-provided host/origin overrides are ignored
- resolve DNS and block loopback/link-local/RFC1918/ULA targets
- explicit IPv6 blocks: `::1`, `fc00::/7`, `fe80::/10`, v4-mapped private ranges; normalize IDNA hostnames before policy checks
- enforce DNS/IP pinning mode against `preview_session.pinnedUpstreamIpsJson` on every request (TOCTOU rebind protection); allow one refresh only after TTL expiry, otherwise deny as rebind
- require non-expired session and matching `revocationVersion` for every proxy request

Header policy:

- inbound allowlist forward only: `accept`, `accept-language`, `content-type`, `if-none-match`, `if-modified-since`, `user-agent`
- strip inbound `cookie`, `authorization`, `x-forwarded-*`
- append server-persisted provider `authHeaders` from `openPreviewTunnel()` metadata (never client-sourced)
- rewrite `origin` and `referer` deterministically:
  - `Origin = upstreamOrigin`
  - `Referer = upstreamOrigin + normalizedPath`
  - never forward raw browser `origin`/`referer` directly
- strip hop-by-hop headers (`connection`, `te`, `upgrade`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `transfer-encoding`, `trailer`)
- assign per-request `proxyReqId` and include it in logs/events and response headers
- set `Cache-Control: no-store`
- SSE responses must set:
  - `Content-Type: text/event-stream`
  - `Connection: keep-alive`
  - `Cache-Control: no-cache, no-transform`
  - `X-Accel-Buffering: no`
  - force `Accept-Encoding: identity` upstream
  - rely on runtime streaming semantics (do not manually set `Transfer-Encoding`)

Operational limits:

- request timeout: 30s (HTTP), 15m idle timeout (SSE)
- request body cap: 2MB (`413` on overflow; `Content-Length` pre-check + streaming byte-counter fallback)
- concurrent proxy requests cap: 16 per `previewSessionId` via Redis semaphore; overflow returns `429` + `Retry-After`
- semaphore uses lease tokens with TTL and `proxyReqId` binding; release on close and GC by expiry for abrupt disconnects
- proxy route must stream request/response bodies (no full buffering) to keep SSE stable in Node runtime

Frame behavior:

- only rewrite `X-Frame-Options` and CSP `frame-ancestors` in verified iframe mode
- run preemptive iframe-cookie probe before first iframe mount; if blocked, immediately fallback to `new_tab` without waiting for hard failure
- if frame bust or cookie block is detected, switch to `new_tab` and emit `v1.preview.session.state_changed` with `unsupportedReason='frame_bust'` or `cookie_blocked`
- explicit probe endpoint: `GET /api/preview/probe/:previewSessionId` sets/reads scoped cookie and returns minimal JS signal used before iframe mount

## Broadcast split contract

Add preview channel type in `packages/types/src/broadcast.ts`:

- `{ type: 'preview', previewSessionId, threadId, runId, userId, schemaVersion: 1 }`

Subscription auth:

- require server-signed short-lived subscription token (TTL 60s, one-time `jti`, `aud='preview-session-broadcast'`) bound to `{previewSessionId,threadId,threadChatId,runId,userId,schemaVersion:1,channelType:'preview'}`
- mint token only after successful exchange and active preview-session binding check
- PartyKit validates token on connect, binds socket to claims tuple, and rejects on any channel-claim mismatch
- fan-out validates event tuple against socket-bound claims (no cross-run, cross-chat, or cross-user replay); mismatch disconnects socket
- expired/revoked session immediately stops fan-out and forces disconnect
- reconnect requires a freshly minted subscription token; reused token/jti is denied
- tuple enums/reasons come from `packages/shared/src/types/preview.ts` to keep auth/event reasons centralized
- `packages/types/src/broadcast.ts` keeps an explicit `schemaVersion` bump policy with compatibility window documentation and startup assertion
- PartyKit enforces one-time subscription `jti` via Redis `SET NX EX`; reused `jti` is denied and disconnected
- broadcast revocation is immediate via revocation push event or short-poll Redis revocation key per socket

Broadcast schema constants:

- `BROADCAST_SCHEMA_VERSION=1` defined in shared types and asserted by both `apps/www` and `apps/broadcast` at startup

Event names (versioned):

- `v1.preview.session.state_changed`
- `v1.preview.validation.attempt_started`
- `v1.preview.validation.attempt_finished`
- `v1.preview.access.denied`

## SHA capture + UI-change classification

### Capture timing

- `runStartSha`: after bind + checkout/pull, before daemon start
- `runEndSha`: terminal daemon envelope `endSha`
- terminal handling happens in daemon-event route:
  - require `endSha` for `done|failed|stopped` envelope
  - resolve live sandbox HEAD via `withThreadSandboxSession` + `git rev-parse HEAD`
  - if `endSha == HEAD`: set `diffSource='sha'` and diff by SHA range
  - if mismatch or HEAD lookup fails: set `diffSource='working-tree-fallback'`, persist mismatch reason in `diffSourceContext`, continue validation with working-tree collector
  - maintenance backstop terminates stale runs missing terminal `endSha` after timeout and records `diffSource='working-tree-fallback'` with timeout reason

### Path collector

`collectChangedPaths()` parser is state-machine based over NUL-delimited `git diff --name-status -z` output and handles:

- `A/M/D/R/C/??`
- rename and copy score fields (`R100`, `C75`)
- spaces/newlines in path names

Classification contract:

- UI rules source: repo-scoped ordered glob config (`.terragon/preview-validation.json`) with explicit `schemaVersion`
- v1 schema requires `{ "schemaVersion": 1, "uiRules": [...] }`
- missing config file => use default conservative UI rule set (`**/*.{tsx,jsx,css,scss,mdx}`, `public/**/*`) with default excludes (`docs/**/*`, `.github/**/*`) and mark decision source as `default_rules`
- invalid JSON or unsupported `schemaVersion` => mark attempt `inconclusive` with blocking reason `ui_rules_invalid` (no silent pass)
- if either side of rename/copy matches a UI rule, validation is required
- persist `matchedUiRulesJson` on each attempt

## Validation executor + maintenance

### Routes

- `POST /api/internal/preview/validate/:threadId/:runId`
- `POST /api/internal/preview/maintenance`

Runtime/auth:

- both routes use Node runtime + force-dynamic
- maintenance route requires HMAC header `x-terragon-internal-signature` + production IP allowlist
- maintenance signature keys use namespace `terragon:v1:internal:hmac:*` with active/previous `kid` rotation
- route-level feature flag gating: return `404` when `sandboxPreview` is disabled
- maintenance scheduling is backed by vercel-cron with idempotent Redis lease to prevent duplicate sweeps

Scheduling and lock:

- lease key: `terragon:v1:preview:validate:lease:{env}:{threadId}:{runId}`
- attempt 1 immediate, attempt 2 at +2m, attempt 3 at +10m, all with +/-20% jitter
- max attempts: 3
- lease TTL: `attemptWindow + 2 * maxExecutionTime`
- per-attempt hard timeout is 8 minutes; timed-out attempt is force-killed and recorded as timed out
- hung-run kill semantics: maintenance kills validator work past hard-timeout + grace and marks run as failed/inconclusive with timeout reason

Evidence and integrity:

- redact secrets from stdout/stderr via centralized redaction pattern registry with provider-specific extensions
- compress logs with gzip
- per-artifact size caps:
  - logs: 10MB each
  - screenshot: 5MB
  - trace: 25MB
  - video: 50MB
- R2 key prefix: `preview/{threadId}/{runId}/{attempt}/...`
- private bucket only; reads via signed URL TTL 300s
- store SHA-256 + byte size for each artifact in DB
- immediately verify hash/size post-upload via object metadata + second durable GET (non-cached path); any mismatch marks attempt failed (`artifact_integrity_mismatch`)
- second durable GET can be disabled in local/dev via explicit feature flag; production remains strict by default
- verify hash/size again on artifact read paths before generating signed URLs used for decisions
- R2 lifecycle expiration at 7 days

Pass criteria:

- `passed` requires: `summary.json` (`tests/passed/failed`), `trace.zip`, and >=1 screenshot
- video optional only when `videoUnsupportedReason` is set and capability probe reported `video=false`
- timed-out executions store sentinel code/reason (`ETERRAGON_TIMEOUT` / `timeout_killed`) distinct from ordinary command failure
- any artifact integrity mismatch forces `inconclusive` or `failed` (never `passed`)

## Ready guard placement + deterministic state machine

Guard wrapper: `withUiReadyGuard(action)` must wrap all ready-transition callsites:

- `openPullRequestForThread`
- `markPRReadyForReview`
- checkpoint auto-ready path
- reopen-after-push path
- GH webhook handlers that auto-mark ready
- any future auto-ready transition helper must compose through this wrapper (single shared entrypoint, no bypass path)
- static no-bypass verification is required in CI: route/action entrypoints that can mark ready must be enumerated and fail if not wrapped by `withUiReadyGuard`

State rules:

- UI-change run starts as `pending`
- terminal outcomes map to `passed|failed|inconclusive|blocked`
- once blocked, only a newer `runId` with `passed` unblocks
- legacy run (`daemonRunIdStrict=false` and missing `runId`) resolves to `inconclusive` when UI rules match, otherwise `not_required`

Draft conversion idempotency:

- idempotency key: `{threadId,runId,'convert_to_draft'}` persisted with outcome
- treat GitHub 422 already-draft as success
- conversion executes at most once per runId
- idempotency marker is stored in DB (`thread_ui_validation` keyed by `{threadId,threadChatId}` with `latestRunId`) rather than process-local memory

## Access cache contract

Redis key:

- `terragon:v1:preview:repo-access:{env}:{userId}:{repoFullName}`

Behavior:

- TTL `min(60s, previewSessionTTLSeconds)`
- negative-cache TTL 5s
- cache miss => direct permission check + populate

Failure semantics:

- proxy requests fail closed on Redis unavailable
- exchange and subscription-token minting fail closed on Redis unavailable (no replay/cache bypass mode)

Forced invalidation triggers:

- ready actions
- thread share/visibility changes
- preview session remint/rebind
- team membership webhook updates
- repo visibility changes
- explicit session revoke or new active run bind
- all callsites must use one helper: `invalidateRepoAccess(userId, repoFullName, reason)`

## Observability + security

Event schema (required fields):

- `schemaVersion`
- `eventName`
- `origin` (`server|client|daemon`)
- `tsServer`
- `traceId`
- `threadId`, `threadChatId`, `runId`, `codesandboxId`, `sandboxProvider`, `previewSessionId?`, `userId?`, `proxyReqId?`

Security reasons enum:

- `expired|revoked|signature_mismatch|binding_mismatch|permission_denied|token_replay|rate_limited|cache_unavailable|proxy_ssrf_blocked|proxy_path_denied`

Canonical HTTP mapping:

- `token_replay` -> `409`
- `rate_limited` -> `429`
- `cache_unavailable` -> `503`
- `proxy_ssrf_blocked|proxy_path_denied|binding_mismatch` -> `403`
- `expired|revoked|signature_mismatch|permission_denied` -> `401/403` by route policy (table documented in task docs)
- mapping table is route-constant backed and unit-tested to prevent divergence

Metrics/SLO:

- SLI: `preview_ready_latency_ms = ts(preview_backend_ready) - ts(sandbox_ready)` using server timestamps only
- SLO: p95 <= 20s over 30-minute windows
- alert thresholds:
  - quarantine > 5/min per repo for 10m
  - preview access denied > 20/min global for 10m
- metric namespace prefix: `preview.*` (for example `preview.strict_mismatch`, `preview.legacy_mode`, `preview.missing_end_sha`)

## Retention and revocation

- preview sessions + artifacts retained 7 days via maintenance and R2 lifecycle
- when `activeRunId` changes or access is revoked, all active preview sessions for thread are revoked and emit `v1.preview.session.state_changed`
- oversized quarantine payloads are offloaded to R2; DB keeps `payloadPrefix2k` + `payloadHash`
- `daemon_event_quarantine` rows are retained 30 days, with daily aggregate emission before purge
- quarantine oversized payload offload is sampled/rate-limited per repo during storms to avoid write amplification

## Compatibility

- Legacy runs remain supported under frozen `daemonRunIdStrict=false` only.
- DB field names remain `codesandbox*`; service layer may expose alias `sandboxInstanceId` but must write/read canonical DB field through shared alias utilities (no ad-hoc naming forks).

## Daemon build artifact policy

- Source of truth is `packages/daemon/src/*`.
- `packages/daemon/dist/index.js` is regenerated by daemon build when envelope/payload contracts change; no manual dist edits.

## Testing matrix (required)

1. Run context and identity

- concurrent `createRunContext` calls with different `startRequestId` still yield one active row
- optimistic concurrency version conflict path retries with bounded exponential backoff
- concurrent starts across same `threadId` but different `threadChatId` remain isolated (no cross-chat contention/collision)
- frozen flag snapshot persists and is used after flag flips
- immutable `thread_run` history is preserved while `thread_run_context` pointer changes

2. Daemon correlation

- strict=false missing runId is legacy-compatible but becomes `inconclusive` when UI rules matched (no masked UI changes)
- strict=true quarantines mismatch/missing runId, returns 202, and emits denied event/metric
- strict metrics are emitted under `preview.*` namespace with expected labels
- daemon event dedupe test: duplicate `eventId` is idempotent with no duplicate writes
- daemon event ordering test: out-of-order `seq` is ignored deterministically
- terminal `endSha` missing/mismatch path falls back to `working-tree-fallback`
- maintenance backstop finalizes stale runs missing terminal `endSha`

3. Auth and proxy security

- bootstrap JWT claim validation (`kid`, `jti`, `iss`, `aud`, skew, TTL) with per-token-namespace key isolation
- JWT replay rejection via `jti` + `nonce` single-use keys
- exchange anti-replay store outage fails closed (no replay-unsafe fallback)
- proxy SSRF/path traversal guard (absolute URL, double-encoded traversal, backslash, private IP, IPv6, CNAME-chain drift, host override)
- proxy header policy appends server-persisted provider `authHeaders` and never trusts client-sourced auth headers
- origin/referer rewrite behavior is deterministic for CSRF-sensitive upstream apps
- DNS/IP pinning rejects TOCTOU rebind drift after session start
- cookie `revocationVersion` mismatch denies proxy access on every request
- sustained + burst rate limit behavior for session start, exchange, and proxy
- per-limiter error payload includes tripped limiter dimension + `nextAllowedAt`
- preview subscription token binding (`previewSessionId/threadId/threadChatId/runId/userId`) rejects wrong-claim subscriptions
- preview subscription token expiry/replay disconnect behavior is enforced and reconnect requires fresh token mint
- one-time subscription `jti` reuse is denied by PartyKit Redis gate

4. Transport/runtime

- preview routes run in Node runtime with force-dynamic
- route-level feature-flag gating returns `404` when preview is disabled
- SSE headers include no-cache + buffering protections and stream without manual transfer-encoding overrides
- SSE soak test validates long-lived stream behavior in production runtime
- WS unsupported returns deterministic `ws_required`
- `POST /api/internal/preview/session/start` lifecycle transitions are emitted in order (`pending -> initializing -> ready|unsupported|error`)
- proxy emits per-request `proxyReqId` for logs/events

5. UI fallback

- preemptive iframe cookie probe triggers `cookie_blocked` fallback before hard iframe failure
- iframe cookie blocked (Safari/Firefox simulation) triggers `cookie_blocked` and new-tab fallback
- frame-bust and ws-required flows emit deterministic unsupported reasons
- unsupported reason mapping differentiates `adapter_unimplemented` vs `capability_missing`

6. Diff/classifier

- NUL parser handles A/M/D/R/C/?? including rename score and special characters
- rename old/new path matching enforces UI validation when either side matches
- `.terragon/preview-validation.json` schema versioning plus missing/invalid behavior is deterministic
- parser fixtures include spaces/newlines/unicode and fuzz coverage for encoded path edge cases

7. Validation artifacts

- capability gate blocks unsupported Playwright environments
- artifact redaction registry + provider extensions are applied
- artifact redaction, size caps, hash persistence, post-upload/read verification, and signed URL access are enforced
- per-attempt hard timeout and hung-run kill semantics are enforced
- pass/fail criteria with required `summary.json`, `trace.zip`, screenshot
- timeout sentinel (`ETERRAGON_TIMEOUT`) and status reason (`timeout_killed`) are asserted

8. Ready guard and draft conversion

- all ready-entry callsites pass through `withUiReadyGuard` (`openPullRequestForThread`, `markPRReadyForReview`, checkpoint auto-ready, reopen-after-push, webhook auto-ready)
- draft conversion idempotency key prevents duplicate conversions
- static no-bypass verification fails CI when an unwrapped ready-entry path is introduced

9. Cache and invalidation

- key format/TTL semantics and negative cache TTL
- invalidation hooks for team/repo visibility changes
- Redis failure behavior is unified fail-closed for proxy/exchange/subscription auth paths
- combined user/IP/session limiter interactions are tested with distinct error payloads

10. Provider and build parity

- sandbox adapter contract tests verify `getPreviewSupport()` shape and unsupported reason mapping (`adapter_unimplemented` vs `capability_missing`)
- daemon dist parity check fails CI when `packages/daemon/dist/index.js` drifts from built source
- provider integration suites are env-gated; CI defaults to mocks when provider credentials are unavailable

## Feature flags

- `sandboxPreview`
- `daemonRunIdStrict`
- definitions in `packages/shared/src/model/feature-flags-definitions.ts`

## Rollout phases

1. Run context transaction/index hardening + daemon envelope v2 + strict/legacy quarantine
2. Preview session auth/proxy hardening + broadcast auth + UI fallback states
3. Validation executor/evidence integrity + shared ready guard + deterministic state machine
4. Telemetry, cache invalidation, retention, docs/release notes, and operational runbooks

## Quick commands

```bash
pnpm tsc-check
pnpm -C apps/www test
pnpm -C packages/sandbox test
pnpm -C packages/shared test
pnpm -C apps/docs build
```

## Acceptance

- [ ] `runId` is canonical in daemon envelopes, DB rows, guard checks, and telemetry.
- [ ] Run-context creation/bind semantics are transaction-safe with immutable `thread_run` rows plus pointer-only `thread_run_context`, including bounded retry/backoff on version conflicts.
- [ ] Bootstrap auth contract defines HS256/kid/jti/nonce/claim binding, separated token audiences/key namespaces, fail-closed replay prevention, and key rotation windows.
- [ ] Proxy contract includes origin/path SSRF hardening, server-only provider `authHeaders`, origin/referer rewrite semantics, provider-aware DNS/IP pinning, revocation-version checks, SSE streaming headers, and WS deterministic fallback.
- [ ] Preview/session/validation state enums and transition rules are explicit and type-checked.
- [ ] Validation artifacts enforce centralized redaction, private access, size caps, immediate post-upload/read hash verification, timeout kill semantics, and lifecycle expiration.
- [ ] Strict and legacy daemon correlation paths are deterministic, observable, and non-retrying, with missing-`endSha` maintenance backstop and legacy UI-change inconclusive behavior.
- [ ] Ready guard wrapper coverage is exhaustive and tested across every ready-entry path, with static no-bypass verification.
- [ ] Access cache semantics are explicit for key format, TTL, invalidation, and unified fail-closed Redis outage behavior.
- [ ] Key management and ops include namespace keystore pointers (`active_kid`/`prev_kid`), replay/rate-limit deterministic error mappings, and documented rotation runbook coverage.
- [ ] Route-level preview feature-flag gating returns `404` across preview endpoints when disabled.
- [ ] Test matrix covers race conditions, event ordering/dedupe, transport behavior, cookie-blocked fallback, IPv6/CNAME rebind edges, diff parser schema-version edge cases, adapter contract parity, and guard idempotency.
- [ ] Internal-only rollout constraints are explicit: Daytona-first support, deterministic E2B unsupported mapping, and emergency operator bypass documented for outage handling.

## References

- `packages/shared/src/model/feature-flags-definitions.ts:1`
- `packages/shared/src/types/preview.ts:1`
- `packages/daemon/src/shared.ts:1`
- `packages/daemon/dist/index.js:1`
- `apps/www/src/agent/msg/send-daemon-message.ts:1`
- `apps/www/src/server-lib/handle-daemon-event.ts:1`
- `apps/www/src/agent/msg/startAgentMessage.ts:1`
- `apps/www/src/agent/sandbox.ts:1`
- `apps/www/src/lib/rate-limit.ts:1`
- `apps/www/src/server-actions/mark-pr-ready.ts:1`
- `apps/www/src/server-actions/pull-request.ts:1`
- `apps/www/src/server-lib/checkpoint-thread.ts:1`
- `apps/www/src/app/api/internal/broadcast/route.ts:1`
- `apps/broadcast/src/auth.ts:1`
- `apps/broadcast/src/server.ts:1`
- `apps/www/src/app/api/internal/preview/session/start/route.ts:1`
- `apps/www/src/app/api/preview/session/[previewSessionId]/exchange/route.ts:1`
- `apps/www/src/app/api/preview/proxy/[previewSessionId]/[...path]/route.ts:1`
- `apps/www/src/app/api/internal/preview/validate/[threadId]/[runId]/route.ts:1`
- `apps/www/src/app/api/internal/preview/maintenance/route.ts:1`
- `packages/types/src/broadcast.ts:1`
- `packages/sandbox/src/types.ts:1`
- `packages/shared/src/db/schema.ts:1`
