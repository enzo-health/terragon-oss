# fn-2-upgrade-linear-integration-to-linear.3 Webhook handler rewrite for agent events

## Description

Rewrite the Linear webhook route and handlers to process `AgentSessionEvent` as the **primary trigger** for thread creation, and `AppUserNotification` as logged-only signals. Implement agent activity emission with correct Linear API shapes and 10-second SLA compliance. Include explicit SLA failure handling, idempotency via `Linear-Delivery-Id` header, and injectable seams for testability.

**Size:** M
**Files:**

- `apps/www/src/app/api/webhooks/linear/route.ts` — rewrite dispatcher for new event types
- `apps/www/src/app/api/webhooks/linear/handlers.ts` — rewrite handlers for agent webhook types
- `apps/www/src/app/api/webhooks/linear/handlers.test.ts` — rewrite tests for new handlers
- `apps/www/src/server-lib/linear-agent-activity.ts` — **create** agent activity emission helpers

## Approach

- **Route rewrite** (`route.ts`):

  - Keep signature verification (HMAC via `LinearWebhookClient`)
  - Extract `Linear-Delivery-Id` header: `const deliveryId = request.headers.get("Linear-Delivery-Id") ?? undefined`
  - Dispatch by `type` field:
    - `AgentSessionEvent` → `handleAgentSessionEvent(payload, deliveryId)` (primary — creates threads)
    - `AppUserNotification` → `handleAppUserNotification(payload)` (log only, no thread creation)
    - Others → 200 OK, skip
  - Remove the old `Comment.create` filter

- **`handleAgentSessionEvent` handler** (PRIMARY TRIGGER):

  - `created` event — always has `agentSession.id`:
    1. Look up `linearInstallation` by `organizationId` → if not found → log error, return 200
    2. **Token refresh with 2-3s hard budget**: `await Promise.race([refreshLinearTokenIfNeeded(...), timeout(2500)])`. On timeout → emit `error` activity ("Authentication failure — please reinstall the Linear Agent") and return 200. Do NOT block.
    3. **SYNCHRONOUSLY emit `thought` activity** (before returning HTTP 200, within 10s): `LinearClient.createAgentActivity({ agentSessionId, content: { type: "thought", body: "Starting work on this issue..." } })`
    4. **10s SLA failure handling**: If `thought` emission throws/rejects → log error with `agentSessionId`, return 200 anyway. Linear does not retry on 200. Thread creation still proceeds via `waitUntil()`.
    5. **Idempotency check** (in `waitUntil()`): call `getThreadByLinearDeliveryId({ db, deliveryId })` (defined in task 1, `model/threads.ts`). If thread exists → skip creation, return.
    6. Return 200 to Linear
    7. **ASYNC via `waitUntil()`**: Extract `promptContext` from `agentSession` → issue context; resolve user from `agentSession.actorId` → `linearAccount.linearUserId` → Terragon `userId`; call `issueRepositorySuggestions(agentSessionId, { candidateRepositories })` (candidates: `[{ fullName: settings.defaultRepoFullName, hostname: "github.com" }]` + user environments from DB, capped at 10, skip nulls); create thread via `newThreadInternal()` with `sourceMetadata` including `agentSessionId`, `linearDeliveryId`; call `LinearClient.agentSessionUpdate({ id: agentSessionId, externalUrls: [taskUrl] })`
  - `prompted` event: Look up thread via `getThreadByLinearAgentSessionId({ db, agentSessionId })` (defined in task 1). If found → queue follow-up via `appendQueuedMessages`. If not found → log warning, return 200. Do NOT create a new thread.
  - Unknown action → log and 200

- **`handleAppUserNotification` handler** (LOG ONLY):

  - Parse notification type (`issueMention`, `issueCommentMention`, `issueAssignedToYou`)
  - Log: `console.log("[linear] AppUserNotification", { organizationId, notificationType, userId })`
  - Do NOT create threads (these lack `agentSessionId`)
  - Return 200 immediately

- **Agent activity helpers** (`linear-agent-activity.ts`):

  - Use `LinearClient.createAgentActivity()` from `@linear/sdk` (typed SDK — no raw GraphQL mutations)
  - Activity content shapes per Linear Agent Interaction docs:
    - `thought`: `{ type: "thought", body: string }`
    - `action`: `{ type: "action", action: string, result?: string }`
    - `response`: `{ type: "response", body: string }`
    - `error`: `{ type: "error", body: string }`
  - `updateAgentSession({ client, sessionId, externalUrls })` — set Terragon task URL
  - **Injectable `LinearClient` factory** for testability: exported helper accepts `opts?: { createClient?: (token: string) => LinearClient }`. Default creates `new LinearClient({ accessToken: token })`. Tests pass a jest/vitest mock factory that returns a stubbed client.
  - Error handling: all emissions wrapped in try/catch; log failures but never throw

- **Repo detection via `issueRepositorySuggestions`**:

  - SDK call: `client.issueRepositorySuggestions(agentSessionId, { candidateRepositories: [{ fullName, hostname }] })`
  - Returns: `{ repositoryFullName, hostname, confidence }[]` — pick highest confidence
  - If empty result or no candidates → fall back to `settings.defaultRepoFullName`

- **Idempotency**: `linearDeliveryId` comes from the `Linear-Delivery-Id` HTTP request header. Stored in `ThreadSourceMetadata.linearDeliveryId`. Before creating a thread in `waitUntil()`, query for existing thread by `linearDeliveryId` to prevent duplicates on Linear retries.

- **Self-loop prevention**: Linear natively filters the app's own activities from triggering new `AppUserNotification` or `AgentSessionEvent`. Remove old `containsMention()` regex detection entirely.

- **Backward compat guard**: Check `thread.sourceMetadata?.agentSessionId` before any activity emission. If absent (legacy fn-1 thread) → log and skip. Do not error.

## Key context

- `AgentSessionEvent.created` payload: `{ type: "AgentSessionEvent", action: "created", organizationId, data: { id: sessionId, agentSession: { id, promptContext: { issueId, issueIdentifier, issueTitle, ... } } } }`
- `AgentSessionEvent.prompted` payload: `{ type: "AgentSessionEvent", action: "prompted", organizationId, data: { id: sessionId, agentActivity: { body } } }`
- `AppUserNotification` payload: `{ type: "AppUserNotification", organizationId, notification: { type, user: { id }, issue: { id } } }` — NO `agentSessionId`
- Use `LinearClient({ accessToken })` for all API calls (not `{ apiKey }`)
- Rate limit: OAuth apps get 500 req/hr. Each webhook handler makes ~3-4 API calls.
- The 10-second SLA means the `thought` activity MUST be emitted synchronously in the webhook handler before returning 200. Token refresh budget is 2-3 seconds max.
- `getThreadByLinearAgentSessionId()` is defined in task 1 (`packages/shared/src/model/threads.ts`)
- `Linear-Delivery-Id` header is set by Linear on every webhook delivery; retrieve via `request.headers.get("Linear-Delivery-Id")`

## Acceptance

- [ ] Route dispatches `AgentSessionEvent` and `AppUserNotification` (old `Comment.create` filter removed)
- [ ] `AgentSessionEvent.created` is the primary trigger — creates thread + emits `thought` synchronously
- [ ] `AgentSessionEvent.prompted` routes follow-up to existing thread by `agentSessionId`
- [ ] `AppUserNotification` events are logged but do NOT create threads
- [ ] `thought` activity emitted SYNCHRONOUSLY before returning 200 (<10s SLA)
- [ ] 10s SLA failure: if `thought` emission fails, log error and return 200 (do not re-throw)
- [ ] Token refresh race: 2-3s hard budget via `Promise.race`; timeout → emit `error` activity + return 200
- [ ] Activity content uses correct Linear API shapes: `{ type: "thought", body }`, `{ type: "action", action }`, etc. (NOT `{ type: "text", text }`)
- [ ] Uses `LinearClient.createAgentActivity()` (typed SDK, no raw GraphQL)
- [ ] Per-workspace OAuth token lookup from `linearInstallation` (no global API key)
- [ ] `issueRepositorySuggestions` called with `agentSessionId` + `candidateRepositories`; fallback to `defaultRepoFullName`
- [ ] `externalUrls` set on agent session with Terragon task link
- [ ] Old regex mention detection removed (`containsMention`, `escapeRegex`)
- [ ] `linearDeliveryId` from `Linear-Delivery-Id` header stored in `sourceMetadata`
- [ ] Idempotency: existing thread with matching `linearDeliveryId` → skip creation (no duplicate threads on retry)
- [ ] Injectable `LinearClient` factory seam in activity helpers for testability
- [ ] Handler tests cover: `created` event, `prompted` event, `AppUserNotification` log-only, SLA failure path, idempotent retry
- [ ] Handler tests pass: `pnpm -C apps/www test src/app/api/webhooks/linear/`
- [ ] Type check passes: `pnpm tsc-check`

## Done summary

Rewrote the Linear webhook handler for AgentSessionEvent support with robust idempotency, token refresh with proper timer cleanup, pre-flight payload eligibility checks before thought emission, and a hardened manual HMAC fallback with timestamp replay protection. The `linear_webhook_deliveries` table uses TTL-based steal logic to prevent concurrent duplicate thread creation while still allowing crash recovery on Linear retries.

## Evidence

- Commits: 1d0c1a247a84a1fbdfc535e477b9478de0d39093
- Tests: pnpm -C apps/www test --run (810 tests, 46 files passed)
- PRs:
