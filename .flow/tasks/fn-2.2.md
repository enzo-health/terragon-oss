# fn-2.2 Implement preview session start/auth, cookie exchange, and proxy transport

## Description

Build secure preview session bootstrap/startup and catchall proxy behavior with SSRF/open-redirect hardening and deterministic transport limits.

**Size:** M
**Files:**

- `apps/www/src/app/api/internal/preview/session/start/route.ts`
- `apps/www/src/server-lib/preview-auth.ts`
- `apps/www/src/lib/rate-limit.ts`
- `apps/www/src/app/api/preview/session/[previewSessionId]/exchange/route.ts`
- `apps/www/src/app/api/preview/proxy/[previewSessionId]/[...path]/route.ts`
- `apps/www/src/app/api/internal/broadcast/route.ts`
- `apps/broadcast/src/auth.ts`
- `apps/broadcast/src/server.ts`
- `packages/shared/src/types/preview.ts`
- `packages/types/src/broadcast.ts`

## Approach

- Add `preview_session` schema with explicit `state`/`unsupportedReason` enums and indexes (`{runId,createdAt desc}`, `{threadId,createdAt desc}`), plus `pinnedUpstreamIpsJson` (`A/AAAA + CNAME + TTL + pinningMode`) + `revocationVersion` + DNS refresh fields (`lastDnsCheckAt`,`dnsRefreshedOnce`).
- Keep this task API-only: preview routing changes are limited to `/api/internal/preview/*` and `/api/preview/*` (no app page routes).
- Import preview/security enums and claim tuple types from `packages/shared/src/types/preview.ts`.
- Add route-level feature-flag gating for preview endpoints in this slice (`start`, `exchange`, `proxy`): return `404` when `sandboxPreview` is disabled.
- Add explicit preview start route:
  - `POST /api/internal/preview/session/start` with `{threadId,threadChatId,runId}`
  - enforce active run binding before startup
  - emit lifecycle transitions in-order: `pending -> initializing -> ready|unsupported|error`
  - use `preview.requiresWebsocket` as the authoritative ws-required signal
  - split unsupported mapping into `adapter_unimplemented` vs `capability_missing`
  - persist `upstreamOrigin`, DNS/IP pin set, and `revocationVersion=1` only after tunnel creation
  - v1 pinning modes are `strict_ip` and `tls_sni_host` only (`provider_asn` deferred); ngrok/CDN fallback uses trusted provider domain/CNAME anchor checks
- Implement bootstrap token verification contract:
  - HS256 JWT with `kid`
  - claims: `iss`, `aud`, `iat`, `exp<=300s`, `jti`, `nonce`, and full run/session binding tuple
  - separate key namespaces/audiences for exchange vs broadcast vs cookie tokens
  - namespaced keystore pointers (`active_kid`, `prev_kid`) and unknown-`kid` rejection/audit
  - clock skew +/-60s
  - startup drift sanity check (Redis/server clock) gates minting when skew exceeds grace
  - replay protection via Redis `SET NX EX` for `jti` and `nonce`
  - Redis replay-store outage fails closed (no replay-unsafe bypass) with deterministic `503` payload (`code`,`retryAfterMs`,`backoffHint`)
  - key rotation with active + previous key (15m grace)
- Add signed proxy cookie token contract (`aud='preview-session-cookie'`) bound to run/session/user tuple + `revocationVersion`.
- Add signed upstream-origin contract using dedicated namespace (`terragon:v1:preview:keys:origin:*`) with claims `{scheme,host,port,pinningMode,exp,previewSessionId,revocationVersion}` verified on each proxy request.
- Add sustained + burst rate limits in `apps/www/src/lib/rate-limit.ts` for session start, exchange, and proxy (`user`, `session`, `ip` dimensions).
- Centralize `getClientIp()` extraction policy for per-IP limits (`x-vercel-ip` -> first `x-forwarded-for` -> remote address) with source-label logging.
- Implement proxy hardening:
  - Node runtime + force-dynamic
  - path normalization and rejection (`scheme://`, `//`, `..`, double-encoded traversal, encoded dot segments, backslash)
  - provider-aware origin pinning modes (`strict_ip`, `provider_asn`, `tls_sni_host`) with DNS/IP/CNAME TTL persistence and rebind protection
  - private/loopback IP SSRF blocking
  - strict forwarded-header allowlist, cookie/auth strip, and server-persisted provider `authHeaders` append (never client-sourced)
  - rewrite `origin` and `referer` to upstream-equivalent values for CSRF-sensitive upstreams; strip hop-by-hop headers (`connection`,`te`,`transfer-encoding`, etc.)
  - enforce cookie `revocationVersion` on every request
  - add per-request `proxyReqId` to logs/events
  - concurrent proxy cap `16` per `previewSessionId` enforced via Redis semaphore with `429` + `Retry-After`
  - request body cap `2MB` with `Content-Length` pre-check + streaming byte counter fallback returning `413`
- Implement SSE pass-through header contract and deterministic WS unsupported (`501`, `ws_required`), including `Cache-Control: no-cache, no-transform` and streaming semantics without manual `Transfer-Encoding`.
- WS unsupported responses include JSON payload `{code:'ws_required'}` for deterministic UI fallback handling.
- Add preview broadcast channel schema versioning and strict subscription token binding:
  - short-lived token (TTL 60s, one-time `jti`, `aud='preview-session-broadcast'`)
  - claims bound to `{previewSessionId,threadId,threadChatId,runId,userId,schemaVersion,channelType}`
  - reconnect requires minting a fresh subscription token
  - PartyKit validates connect-time tuple match and fan-out tuple match in `apps/broadcast/src/auth.ts` and `apps/broadcast/src/server.ts`, disconnecting mismatches
  - PartyKit enforces one-time subscription `jti` via Redis `SET NX EX` and disconnects reuse attempts
  - PartyKit applies immediate revocation handling (push event or short-poll revocation key) so `revocationVersion` changes drop sockets quickly
  - enforce broadcast schema-version compatibility policy and startup assertion.

## Acceptance

- [ ] Bootstrap exchange is query-token-free and enforces claim binding, replay protection, fail-closed outage handling, and rotation semantics.
- [ ] Preview session start route enforces active run binding and deterministic lifecycle transitions.
- [ ] Cookie token and attributes are explicit (`HttpOnly`,`Secure`,`Path`,`SameSite`,`Max-Age`,`revocationVersion`) and mode-correct.
- [ ] Proxy rejects open-redirect/SSRF/rebind vectors, rewrites CSRF-sensitive `origin`/`referer`, and never trusts client host/auth overrides.
- [ ] SSE runtime/header requirements include no-cache streaming behavior (without manual transfer-encoding) and are test-covered.
- [ ] Preview channel parse/auth path validates bound subscription token claims at connect and fan-out.
- [ ] PartyKit enforces one-time `jti` and immediate disconnect on token/tuple mismatch.
- [ ] Rate limit contracts for session start/exchange/proxy are centralized in `apps/www/src/lib/rate-limit.ts` with sustained + burst semantics.
- [ ] Route-level preview feature-flag gating returns `404` when disabled.
- [ ] Preview scope here remains API-only (`/api/internal/preview/*`, `/api/preview/*`) with no new app page routes.

## Test matrix

- Unit: token claim validation (`kid`,`jti`,`iss`,`aud`,`exp`,`skew`) enforces audience/key namespace separation and JWT replay rejection (`jti` + `nonce`).
- Integration: replay-store Redis outage fails exchange closed.
- Unit: key lookup/rotation contract enforces namespace-scoped `active_kid`/`prev_kid` and rejects unknown `kid`.
- Integration: start route persists DNS/IP pin set, respects `requiresWebsocket`, and splits `adapter_unimplemented` vs `capability_missing`.
- Integration: proxy SSRF/path traversal validation blocks absolute URL, double-encoded traversal, encoded `..`, backslash, host override, and private IP/rebind targets (including IPv6 + CNAME chain cases).
- Integration: proxy appends server-stored provider `authHeaders`, rewrites `origin`/`referer`, and rejects stale `revocationVersion`.
- Integration: SSE headers include no-cache streaming contract (no manual TE) and WS returns `ws_required`.
- Integration: WS unsupported path returns `501` with `{code:'ws_required'}` payload.
- Integration: proxy body cap enforces `413` in both content-length and streaming-overflow paths.
- Integration: Redis semaphore enforces concurrent proxy cap with deterministic `429` + `Retry-After`.
- Integration: per-request `proxyReqId` is emitted in proxy logs/events.
- Integration: start route emits ordered lifecycle transitions (`pending -> initializing -> ready|unsupported|error`).
- Integration: sustained/burst limits are enforced for session start, exchange, and proxy dimensions with limiter-specific error payloads.
- Integration: preview subscription token wrong-claim, expiry, replay, and reconnect-without-fresh-token paths are denied.
- Integration: PartyKit connect/fan-out tuple mismatch (`previewSessionId/threadId/threadChatId/runId/userId`) is denied and socket is disconnected.
- Integration: PartyKit subscription `jti` reuse is denied via Redis single-use guard.
- Integration: revocation-version change forces active preview sockets to disconnect promptly.
- Integration: route-level feature flag disabled returns `404` for `start`, `exchange`, and `proxy`.
- E2E: SSE soak test verifies stable streaming behavior in production runtime profile.

## Done summary

- Task completed

## Evidence

- Commits:
- Tests:
- PRs:
