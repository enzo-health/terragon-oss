# fn-2-upgrade-linear-integration-to-linear.4 Agent activity lifecycle during thread execution

## Description

Hook into the daemon event processing pipeline to emit Linear agent activities during thread execution. Time-throttle `action` emissions to max 1 per 30 seconds per session. Use correct Linear activity API shapes. Provide injectable clock seam for testability.

**Size:** M
**Files:**

- `apps/www/src/server-lib/handle-daemon-event.ts` — add Linear activity emission hook
- `apps/www/src/server-lib/linear-agent-activity.ts` — extend with `emitLinearActivitiesForDaemonEvent()` orchestrator + throttling

## Approach

- **Detection**: At the top of `handleDaemonEvent()` (after fetching `thread` at L67-75), check:

  - `thread.sourceType === "linear-mention"` AND
  - `thread.sourceMetadata?.agentSessionId` is non-null/non-empty
  - If either condition fails → skip all Linear logic entirely. This handles legacy fn-1 threads (no `agentSessionId`) and all non-linear threads cleanly.

- **Time-based throttling in `emitLinearActivitiesForDaemonEvent`**:

  - Module-level `Map<string, number>` — tracks last emission timestamp per `agentSessionId`
  - For `action` activities only: emit if `now() - lastEmit >= 30_000` (30 seconds)
  - Terminal events (`response` on `isDone`, `error` on `isError`) always bypass throttle
  - **Injectable clock** for testability: `emitLinearActivitiesForDaemonEvent(thread, messages, opts?: { now?: () => number })`. Default `now = () => Date.now()`. Tests pass fake timestamps to advance/freeze time without real delays.
  - In-memory throttle is acceptable here (unlike token refresh CAS): worst case = one extra `action` activity emitted per serverless cold start. No correctness risk.

- **Activity emission during messages**: After processing daemon messages (after L250 in `handle-daemon-event.ts`), if Linear-sourced and throttle allows:

  - Extract last assistant message text as progress summary (truncate to 200 chars)
  - Call `createAgentActivity({ agentSessionId, content: { type: "action", action: summary } })` via `waitUntil()`
  - Update throttle map: `lastEmitMap.set(agentSessionId, now())`

- **Completion** (`isDone` at L201): Emit `response` activity (bypass throttle)

  - `createAgentActivity({ agentSessionId, content: { type: "response", body: resultSummary } })`
  - Include cost and duration in body if available from daemon result

- **Error** (`isError` at L201): Emit `error` activity (bypass throttle)

  - `createAgentActivity({ agentSessionId, content: { type: "error", body: errorMessage } })`

- **Token management**: Use `getLinearInstallationForOrg()` + `refreshLinearTokenIfNeeded()` from task 1's `linear-oauth.ts` before each emission batch

- **Failure isolation**: All Linear activity emissions are wrapped in try/catch and run via `waitUntil()`. A failed emission must never affect thread processing.

- **Session update on completion**: When thread finishes (in `handleThreadFinish` at L517), update agent session `externalUrls` if not already set (in case task 3's `agentSessionUpdate` was missed).

## Key context

- `handle-daemon-event.ts` processes ALL daemon events for ALL thread types. The Linear hook must be cleanly isolated — early-exit via source type + agentSessionId guard.
- `handleThreadFinish` at L517-555 runs async via `waitUntil()`. Linear session completion can piggyback.
- The `thread` object includes `sourceType` and `sourceMetadata` (with `agentSessionId` after task 1).
- Activity content shapes (correct per Linear Agent Interaction docs):
  - `action`: `{ type: "action", action: "Running tests on auth module", result?: "3 tests passed" }`
  - `response`: `{ type: "response", body: "Completed task. Created PR #42 with..." }`
  - `error`: `{ type: "error", body: "Failed: sandbox timeout after 300s" }`
- In-memory throttle map is acceptable here (unlike token refresh) because worst case of lost throttle state = one extra activity emission, which is harmless. No DB-level guard needed.
- Linear sessions go "stale" after ~30 minutes but are recoverable — low-frequency updates are fine.
- Rate limit: OAuth apps get 500 req/hr. Throttling to 1/30s per session is well within budget even with many concurrent sessions.

## Acceptance

- [ ] Linear-sourced threads emit `action` activity on daemon message batches (throttled: max 1/30s per `agentSessionId`)
- [ ] `response` activity emitted when thread completes (`isDone`) — bypasses throttle
- [ ] `error` activity emitted when thread fails (`isError`) — bypasses throttle
- [ ] Activity content uses correct shapes: `{ type: "action", action }`, `{ type: "response", body }`, `{ type: "error", body }` (NOT `{ type: "text", text }`)
- [ ] Token refresh called before each emission batch
- [ ] Activity emission failures are caught and logged (never block thread processing)
- [ ] Non-Linear threads are completely unaffected (early-exit check on `sourceType` + `agentSessionId`)
- [ ] Legacy fn-1 threads (missing `agentSessionId`) skipped gracefully with a log warning
- [ ] Injectable `now` clock param in `emitLinearActivitiesForDaemonEvent` for testing throttle behavior
- [ ] Time-based throttling prevents Linear rate limit exhaustion (max 1 `action` per 30s)
- [ ] Type check passes: `pnpm tsc-check`
- [ ] Existing tests pass: `pnpm -C apps/www test`

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
