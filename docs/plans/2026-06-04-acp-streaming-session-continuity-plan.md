---
title: ACP Streaming Session Continuity Fix
status: active
date: 2026-06-04
complexity: high
---

# Plan: ACP Streaming Session Continuity Fix

## Problem Frame

ACP streaming dies after a few turns because the runtime currently mixes two incompatible models:

```text
Web app persists threadChat.sessionId
  -> dispatch sends it as acpSessionId
  -> daemon restarts sandbox-agent every ACP run
  -> daemon ignores prior acpSessionId and calls session/new
  -> old ACP child/session dies
  -> later POST/SSE can hit a dead child or lose terminal state
```

The proper fix is to make ACP session ownership explicit and stable. The ACP session must stay alive across follow-up turns in the normal path. The daemon should only restart sandbox-agent when the sandbox agent process is unhealthy, the sandbox was resumed, or recovery explicitly requires a restart. Runtime auth must be refreshed without killing the ACP host process. The durable ACP identity is the pair `{ acpServerId, acpSessionId }`, while AG-UI `runId` remains per turn.

## Scope

In scope:

- Preserve one live ACP server/session across follow-up turns.
- Stop unconditional sandbox-agent restarts on every ACP run.
- Decouple per-run daemon auth from sandbox-agent process lifetime.
- Persist and validate the actual ACP session id returned by `session/new`.
- Add recovery for stale ACP sessions without losing the turn.
- Define cleanup, cancellation, concurrency, and migration behavior for long-lived ACP sessions.
- Add tests that reproduce multi-turn ACP streaming and dead-child recovery.

Out of scope:

- Replacing ACP with codex-app-server.
- Rebuilding the AG-UI SSE endpoint.
- Making ACP stateless by replaying full durable conversation history into each prompt.
- Changing user-facing chat UI behavior except eliminating failed/stuck runs.

## Architecture Decision

Use **stateful ACP session continuity** as the first fix. The normal follow-up path must not create a new ACP session.

Rationale:

- ACP already exposes `session/new` and `session/prompt`; the current dispatch path already carries `acpSessionId`.
- The daemon already records `acpSessionId` in run state and the web app persists session ids on terminal daemon events.
- Restarting sandbox-agent is the direct cause of stale sessions and broken child pipes.
- Stateless ACP would require carefully replaying durable history, tool state, permission state, and model-specific context. That is a larger migration, not the narrow reliability fix.

Target flow:

```text
first ACP turn
  -> ensure sandbox-agent is running with auth generation G
  -> initialize stable ACP server for threadChat
  -> session/new
  -> persist acpServerId + acpSessionId
  -> session/prompt streams and terminates

follow-up ACP turn
  -> same sandbox-agent process still healthy
  -> update per-run auth without process restart
  -> reconnect to same acpServerId/acpSessionId
  -> session/prompt using persisted durable ACP identity
  -> if invalid/dead session, create one replacement session and retry prompt once
```

## Implementation Units

### Unit 1: Introduce Durable ACP Identity

- **Files**:
  - `apps/www/src/agent/runtime/claude-code-implementation-adapter.ts`
  - `apps/www/src/agent/runtime/implementation-adapter.ts`
  - `apps/www/src/agent/msg/startAgentMessage.ts`
  - `packages/shared/src/db/schema.ts`
  - `packages/shared/src/model/agent-run-context.ts`
  - `apps/www/src/app/api/daemon-event/route.ts`
  - `apps/www/src/app/api/daemon-event/route.test.ts`
- **Change**:
  - Treat `{ acpServerId, acpSessionId }` as the durable ACP identity.
  - Make `acpServerId` thread-chat scoped, not run scoped. A stable shape is `terragon-thread-chat-${threadChatId}` or an opaque generated value stored with the thread chat/runtime session.
  - Continue generating a fresh `runId` per turn for AG-UI run lifecycle and daemon-event sequencing.
  - Persist the resolved ACP identity after `session/new` and after stale-session replacement.
  - Store requested vs resolved identity in `agentRunContext` so diagnostics can distinguish “asked to resume stale session” from “created replacement session.”
- **Acceptance Criteria**:
  - First ACP turn creates and persists both `acpServerId` and `acpSessionId`.
  - Follow-up ACP dispatch includes the same `acpServerId` and `acpSessionId`.
  - `runId` changes per turn; ACP identity does not change on healthy follow-up.
  - Existing stale rows with only `sessionId` fall back gracefully by creating a replacement durable identity.
- **Tests**:
  - Adapter tests for stable ACP identity across follow-up turns.
  - Daemon-event route tests that persist replacement identity after invalid-session recovery.
  - Regression test that per-run `runId` is never used as durable `acpServerId`.

### Unit 2: Refresh Runtime Auth Without Restarting Sandbox-Agent

- **Files**:
  - `packages/daemon/src/daemon.ts`
  - `packages/sandbox/src/setup.ts`
  - `packages/daemon/src/daemon.test.ts`
- **Change**:
  - Replace `ensureSandboxAgentHasToken()` with `ensureSandboxAgentRuntime()`.
  - Stop using sandbox-agent process restart as the normal token propagation mechanism.
  - Add or use a per-run auth channel that does not kill the ACP process. Preferred order:
    - Pass daemon token/proxy auth through ACP request headers if sandbox-agent supports forwarding runtime auth to spawned agent requests.
    - Add a sandbox-agent runtime-auth update endpoint or config channel, keyed by ACP server/session.
    - As a temporary compatibility path only, restart when auth cannot be refreshed and mark the ACP session invalid so recovery is explicit.
  - Keep `DAEMON_TOKEN` env inheritance only as startup bootstrap or emergency fallback.
  - Preserve the emergency env flag `TERRAGON_ACP_RESTART_EVERY_RUN=1` for rollback.
- **Acceptance Criteria**:
  - A normal follow-up ACP turn does not call `pkill`.
  - A normal follow-up ACP turn does not restart sandbox-agent.
  - Fresh daemon auth is used for per-run server calls/proxy calls.
  - Recovery from broken pipe can still restart once and deliberately invalidates the prior ACP session.
  - Existing startup health probing remains intact.
- **Tests**:
  - Daemon unit coverage asserting two sequential ACP turns reuse the sandbox-agent process.
  - Coverage asserting auth refresh happens without `pkill`.
  - Coverage asserting dead-child recovery still restarts and retries once.

### Unit 3: Honor Durable ACP Identity On Resume

- **Files**:
  - `packages/daemon/src/daemon.ts`
  - `packages/daemon/src/runtime.ts`
  - `packages/daemon/src/runtime.test.ts`
  - `packages/daemon/src/daemon.test.ts`
- **Change**:
  - In `runAcpTransportCommand()`, distinguish start vs resume using the runtime adapter contract and durable ACP identity.
  - If `{ acpServerId, acpSessionId }` exists and sandbox-agent was not restarted, send `session/prompt` directly to that session.
  - Only call `session/new` when:
    - no durable ACP identity exists,
    - sandbox-agent was restarted or sandbox resumed,
    - ACP server returns invalid-session/session-not-found,
    - health probe proves the session is gone.
  - Add a `probeAcpSession()` helper if sandbox-agent exposes a cheap session-info/ping method. If not, classify invalid-session errors from `session/prompt` and recover there.
- **Acceptance Criteria**:
  - First turn call sequence: `initialize`, `session/new`, `session/prompt`.
  - Healthy follow-up call sequence: optional `initialize` or health check, `session/prompt`, no `session/new`.
  - Invalid session call sequence: `session/prompt`, `session/new`, `session/prompt`.
  - The replacement session id is persisted before the next follow-up.
- **Tests**:
  - Extend ACP daemon tests to inspect JSON-RPC call sequence across three turns.
  - Add invalid-session recovery test.
  - Add hibernation/resume test that clears identity and creates a fresh session.

### Unit 4: Serialize Prompts Per ACP Session

- **Files**:
  - `apps/www/src/server-lib/follow-up-command.ts`
  - `apps/www/src/server-lib/process-queued-thread.ts`
  - `apps/www/src/agent/msg/startAgentMessage.ts`
  - `packages/daemon/src/daemon.ts`
  - relevant queue/daemon tests
- **Change**:
  - Enforce one active `session/prompt` per durable ACP identity.
  - Treat queued follow-ups as serialized turns, not concurrent prompts into one session.
  - Keep daemon-side protection even if web queue logic misfires: reject or queue a second prompt while a prompt is active for the same ACP identity.
  - Ensure `stop`/`retry` paths do not race with replacement session creation.
- **Acceptance Criteria**:
  - Two user follow-ups cannot run concurrently against one ACP session.
  - The second follow-up starts only after the first terminal event or explicit cancellation.
  - Queue semantics continue to produce one AG-UI run lifecycle per user message.
- **Tests**:
  - Queue tests for active ACP run plus queued follow-up.
  - Daemon test for duplicate prompt guard on same ACP identity.

### Unit 5: Define Stop, Cancel, Cleanup, And Hibernation Semantics

- **Files**:
  - `packages/daemon/src/daemon.ts`
  - `apps/www/src/server-lib/stop-thread.ts`
  - `apps/www/src/server-lib/archive-thread.ts`
  - `apps/www/src/agent/sandbox-resource.ts`
  - `apps/www/src/server-actions/archive-thread.ts`
  - relevant stop/archive/sandbox tests
- **Change**:
  - Split cancellation into:
    - **interrupt active prompt**: stop current turn but keep ACP session if the provider reports clean interrupt.
    - **destroy ACP session**: archive, hibernate, sandbox teardown, explicit recovery after corrupted/dead child.
  - On archive or sandbox teardown, call the ACP cleanup/delete endpoint for the durable `acpServerId` and clear persisted ACP identity.
  - On hibernation/resume, clear persisted ACP identity before next dispatch because the in-sandbox ACP process is gone.
  - Add idle cleanup if sandbox remains alive but the thread-chat is inactive beyond a configured window.
- **Acceptance Criteria**:
  - User stop does not destroy a healthy ACP session unless the provider cannot interrupt safely.
  - Archive/hibernation/sandbox teardown destroys or invalidates the ACP session.
  - Follow-up after hibernation creates a fresh session instead of attempting stale resume.
  - No orphaned ACP child is left after archive in the happy path.
- **Tests**:
  - Stop-thread tests for interrupt vs destroy behavior.
  - Archive tests that clear ACP identity.
  - Resume-from-booting tests that force fresh `session/new`.

### Unit 6: Harden Streaming Completion And Recovery Classification

- **Files**:
  - `packages/daemon/src/daemon.ts`
  - `packages/daemon/src/acp-adapter.ts`
  - `packages/daemon/src/acp-adapter.test.ts`
  - `packages/shared/src/model/agent-run-context.ts`
- **Change**:
  - Keep direct `session/prompt` stopReason as terminal.
  - Keep SSE terminal as terminal.
  - Do not treat transient early ACP `Internal error` as terminal before a prompt has emitted meaningful content.
  - Classify failures explicitly:
    - `acp_dead_child_pipe`,
    - `acp_invalid_session`,
    - `acp_stream_lost_after_content`,
    - `acp_completion_timeout`,
    - `acp_auth_refresh_failed`.
  - Record failure classification in run context and visible runtime error metadata.
- **Acceptance Criteria**:
  - A prompt POST stopReason reliably finishes the run even if SSE misses the terminal echo.
  - A recoverable pre-content broken pipe retries once.
  - A post-content stream loss surfaces a precise runtime error instead of generic timeout.
  - Operators can distinguish invalid session from dead child from auth refresh failure.
- **Tests**:
  - ACP adapter tests for terminal response parsing.
  - Daemon tests for POST-terminal-only completion.
  - Daemon tests for SSE-terminal-only completion.
  - Daemon-event tests for failure classification persistence.

### Unit 7: Add Multi-Turn Integration Coverage

- **Files**:
  - `apps/www/test/integration/acp-turn.test.tsx`
  - `apps/www/test/integration/recordings/acp-streaming-turn.jsonl`
  - optional new recording: `apps/www/test/integration/recordings/acp-multi-turn-streaming.jsonl`
- **Change**:
  - Add a deterministic two or three-turn ACP replay that asserts the second follow-up streams, terminates, and preserves session continuity.
  - Include a dead-session recovery fixture if practical.
- **Acceptance Criteria**:
  - Integration test fails on current unconditional restart/session-new behavior.
  - Test passes after session continuity is implemented.
  - AG-UI replay still emits one run lifecycle per turn.
  - The second and third turns reuse the same durable ACP identity.
- **Validation**:
  - `pnpm -C packages/daemon test`
  - `pnpm -C apps/www test -- acp-turn`
  - `pnpm tsc-check`

### Unit 8: Add Production Observability And Migration Safety

- **Files**:
  - `packages/daemon/src/daemon.ts`
  - `apps/www/src/app/api/daemon-event/route.ts`
  - `apps/www/src/components/admin/thread-content.tsx`
  - `packages/shared/src/model/agent-run-context.ts`
- **Change**:
  - Emit structured logs for:
    - `runId`,
    - `threadChatId`,
    - `acpServerId`,
    - `acpSessionId`,
    - lifecycle operation (`start`, `resume`, `replace-session`, `destroy-session`),
    - sandbox-agent restart reason,
    - session replacement reason,
    - auth refresh mode,
    - terminal source (`post`, `sse`, `timeout`, `error`).
  - Add migration-safe behavior for existing stale `threadChat.sessionId` rows:
    - attempt resume once,
    - classify invalid-session,
    - create replacement session,
    - persist replacement,
    - continue the user turn.
  - Expose requested/resolved ACP identity in admin diagnostics.
- **Acceptance Criteria**:
  - A production failure report can be traced without shelling into the sandbox first.
  - Existing stale ACP sessions do not hard-fail the first post-deploy follow-up.
  - Admin thread view distinguishes run id from durable ACP identity.
- **Tests**:
  - Daemon-event tests for stale-session replacement.
  - Admin rendering test if diagnostics UI changes are non-trivial.

## Deployment Strategy

1. Ship behind existing ACP transport flag behavior; do not widen ACP rollout.
2. Add structured daemon logs for:
   - sandbox-agent restart reason,
   - auth refresh mode,
   - ACP lifecycle operation (`start` or `resume`),
   - requested/resolved ACP server/session identity,
   - recovery reason.
3. Watch production for:
   - lower `Broken pipe`/502 ACP POST failures,
   - fewer ACP completion timeouts,
   - successful follow-up turns with stable session ids.

## Rollback Plan

- Keep the old restart-on-every-run path behind a temporary emergency env flag, e.g. `TERRAGON_ACP_RESTART_EVERY_RUN=1`.
- If session reuse causes worse failures, flip the flag while preserving the improved diagnostics and tests.
- Do not roll back daemon-event session persistence unless it corrupts session ids; stale session replacement depends on it.

## Risks And Gotchas

- **Token propagation may be the real reason for per-turn restart.** Unit 2 must resolve this directly. Restarting every turn is not acceptable because it violates the cross-turn session invariant.
- **ACP server id semantics likely require stable server ids.** Treat durable `{ acpServerId, acpSessionId }` as required unless sandbox-agent documentation or tests prove `sessionId` is globally routable.
- **Hibernation must clear ACP session ids.** The web app already clears non-Codex session ids when status is `booting`; verify Daytona resume paths set that status consistently.
- **Codex via ACP is a routing smell.** Codex should prefer codex-app-server. ACP fixes should support Codex only where explicitly enabled, not silently move Codex traffic onto ACP.
- **Long-lived sessions need cleanup discipline.** Fixing per-turn session death creates a new responsibility: archive, hibernate, teardown, and idle cleanup must destroy or invalidate ACP sessions deliberately.
- **Prompt concurrency can corrupt session state.** Long-lived sessions must be single-flight for `session/prompt`; queueing is part of correctness, not just UX.
