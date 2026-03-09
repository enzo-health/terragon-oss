# SDLC Reliability Redesign — Architecture RFC

| Field     | Value                              |
| --------- | ---------------------------------- |
| Title     | SDLC Dispatch Reliability Redesign |
| Authors   | Tyler Sheffield                    |
| Status    | Proposed                           |
| Date      | 2026-03-08                         |
| Reviewers | TBD                                |

---

## 1. Problem Statement

### 1.1 The Recurring Failure

The SDLC loop's Planning→Implementing transition fails with **"Agent did not respond. Command failed with exit code -1"**. This is the most user-visible SDLC failure today. The agent completes planning, the system transitions to implementing, but the implementing phase never starts. The thread gets stuck, and users see a generic error.

### 1.2 Why Previous Fixes Failed

Previous fixes treated symptoms, not structure:

- Adding retry logic around `sendMessage` — the retries hit the same dead daemon socket.
- Adding SDLC error recovery (auto-retry with "Continue" messages) — only fires for `implementing`+ phases, and requires a daemon that is alive to dispatch.
- Adding a crash-recovery fallback in `daemon-event/route.ts` — the `waitUntil` path fires too late and races with the follow-up queue.

Each fix was **local** and could not address the **systemic** gap: two independent mechanisms both fail to dispatch the implementing phase.

### 1.3 The Two-Pronged Dispatch Gap

There are exactly two paths that can dispatch a follow-up agent run after a phase completes:

1. **Self-dispatch** (fast path): The daemon sends terminal messages to the server. The server returns a `selfDispatch` payload in the HTTP response. The daemon starts the next run immediately without a round-trip through the queue.

2. **Queue-based dispatch** (fallback path): The server queues a follow-up message on the thread chat. A separate call to `maybeProcessFollowUpQueue` → `startAgentMessage` resumes the sandbox and sends the daemon message.

**Both paths are broken for Planning→Implementing:**

- **Self-dispatch**: `signal-inbox.ts` suppresses all feedback signals (including `daemon_terminal`) when the loop state is `"planning"`. Even if suppression were removed, the guard `typeof loop.prNumber === "number"` blocks routing because no PR exists during planning.

- **Queue-based dispatch**: `startAgentMessage` calls `getSandboxForThreadOrNull` with `fastResume: true`. This flows into `setupSandboxEveryTime` where the condition `!isCreatingSandbox && !options.fastResume` prevents `restartDaemonIfNotRunning` from executing. If the daemon died between the planning completion and the implementing dispatch, the follow-up message is sent to a dead socket. All 4 retry attempts in `sendMessage` fail against the same dead socket.

---

## 2. Current Architecture (As-Is)

### 2.1 Component Responsibilities

| Component                | File(s)                                                           | Responsibility                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daemon**               | `packages/daemon/src/daemon.ts`                                   | Long-running Node.js process on the sandbox. Listens on Unix socket, spawns agent CLI processes, buffers messages, flushes to server API, handles self-dispatch.  |
| **Daemon Runtime**       | `packages/daemon/src/runtime.ts`                                  | System operations: Unix socket server, process spawning, signal handling, HTTP posting to server.                                                                 |
| **Daemon Entry**         | `packages/daemon/src/index.ts`                                    | CLI entry point. No `unhandledRejection`/`uncaughtException` handlers.                                                                                            |
| **Sandbox Setup**        | `packages/sandbox/src/setup.ts`                                   | `setupSandboxEveryTime`: daemon health check, agent file updates. `fastResume` flag skips expensive ops but also skips `restartDaemonIfNotRunning`.               |
| **Sandbox Daemon**       | `packages/sandbox/src/daemon.ts`                                  | `sendMessage`: base64-encodes JSON, pipes to daemon via `--write`. `restartDaemonIfNotRunning`: ping → kill → restart → wait. 4 retries with exponential backoff. |
| **Server Daemon Bridge** | `apps/www/src/agent/daemon.ts`                                    | `sendDaemonMessage`: creates API key/credentials, sends via `sendMessage`, wraps errors into `ThreadError` with `"agent-not-responding"`.                         |
| **Daemon Event Route**   | `apps/www/src/app/api/daemon-event/route.ts`                      | Receives daemon messages. Handles envelope v2, SDLC signal inbox ticks, self-dispatch payload construction, follow-up queue processing.                           |
| **Handle Daemon Event**  | `apps/www/src/server-lib/handle-daemon-event.ts`                  | Processes daemon messages into DB updates. SDLC error recovery (auto-retry). Calls `handleThreadFinish` for terminal messages.                                    |
| **Signal Inbox**         | `apps/www/src/server-lib/sdlc-loop/signal-inbox.ts`               | Processes SDLC signals (daemon terminal, check runs, PR reviews). Routes feedback to enrolled threads. Suppresses signals during certain loop states.             |
| **Checkpoint Pipeline**  | `apps/www/src/server-lib/checkpoint-thread-internal.ts`           | Phase gate evaluation (planning gate, implementation gate). State transitions via `transitionSdlcLoopStateWithArtifact`. Queues follow-up messages.               |
| **Follow-Up Queue**      | `apps/www/src/server-lib/process-follow-up-queue.ts`              | `maybeProcessFollowUpQueue`: reads queued messages, transitions thread status, calls `startAgentMessage`.                                                         |
| **Start Agent Message**  | `apps/www/src/agent/msg/startAgentMessage.ts`                     | Resumes sandbox (with `fastResume: true` for non-new threads), determines transport mode, sends daemon message.                                                   |
| **Gate Executors**       | `apps/www/src/server-lib/sdlc-loop/{carmack,deep}-review-gate.ts` | Run Codex CLI in sandbox to evaluate code quality gates. Use `runStructuredCodexGateInSandbox` from `sandbox-codex-gate.ts`.                                      |

### 2.2 Data Flow: Planning → Implementing (THE BROKEN PATH)

```
Agent completes planning
        │
        ▼
Daemon sends terminal messages ──► POST /api/daemon-event
        │                                    │
        │                         ┌──────────┴──────────────┐
        │                         │ handleDaemonEvent()     │
        │                         │ - stores messages       │
        │                         │ - checkpointThread()    │
        │                         │   └─► planning gate     │
        │                         │       └─► pass? ──────┐ │
        │                         │           │           │ │
        │                         │       transition to   │ │
        │                         │       "implementing"  │ │
        │                         │           │           │ │
        │                         │       queue follow-up │ │
        │                         │       message         │ │
        │                         └───────────┬───────────┘ │
        │                                     │             │
        │                         ┌───────────┴─────────┐   │
        │                  PATH A │ Self-dispatch        │   │
        │                         │ (daemon-event route) │   │
        │                         │                      │   │
        │                         │ signal-inbox tick    │   │
        │                         │   causeType=         │   │
        │                         │     daemon_terminal  │   │
        │                         │       ▼              │   │
        │                         │ ╔═══════════════╗    │   │
        │                         │ ║ BLOCKED:      ║    │   │
        │                         │ ║ "planning" in ║    │   │
        │                         │ ║ suppressed    ║    │   │
        │                         │ ║ states set    ║    │   │
        │                         │ ╚═══════════════╝    │   │
        │                         └──────────────────────┘   │
        │                                                    │
        │                         ┌──────────────────────┐   │
        │                  PATH B │ Queue-based dispatch  │   │
        │                         │ maybeProcess          │   │
        │                         │   FollowUpQueue()     │   │
        │                         │       ▼               │   │
        │                         │ startAgentMessage()   │   │
        │                         │       ▼               │   │
        │                         │ getSandbox(           │   │
        │                         │   fastResume=true)    │   │
        │                         │       ▼               │   │
        │                         │ setupSandboxEveryTime │   │
        │                         │   fastResume=true     │   │
        │                         │       ▼               │   │
        │                         │ ╔═══════════════╗     │   │
        │                         │ ║ SKIPPED:      ║     │   │
        │                         │ ║ restartDaemon ║     │   │
        │                         │ ║ IfNotRunning  ║     │   │
        │                         │ ╚═══════════════╝     │   │
        │                         │       ▼               │   │
        │                         │ sendDaemonMessage()   │   │
        │                         │       ▼               │   │
        │                         │ sendMessage() x4      │   │
        │                         │   ALL FAIL:           │   │
        │                         │   daemon is dead      │   │
        │                         │       ▼               │   │
        │                         │ ╔═══════════════╗     │   │
        │                         │ ║ ERROR:        ║     │   │
        │                         │ ║ agent-not-    ║     │   │
        │                         │ ║ responding    ║     │   │
        │                         │ ╚═══════════════╝     │   │
        │                         └──────────────────────┘   │
        │                                                    │
        ▼                                                    │
  ╔══════════════════╗                                       │
  ║ THREAD STUCK     ║◄─────────────────────────────────────┘
  ║ User sees error  ║
  ╚══════════════════╝
```

### 2.3 Data Flow: Implementing → Reviewing (THE WORKING PATH)

```
Agent completes implementing
        │
        ▼
Daemon sends terminal messages ──► POST /api/daemon-event
        │                                    │
        │                         ┌──────────┴──────────────┐
        │                         │ handleDaemonEvent()     │
        │                         │ - checkpointThread()    │
        │                         │   └─► implementation    │
        │                         │       gate + review     │
        │                         │       gates run         │
        │                         │       └─► transition    │
        │                         │           to "reviewing"│
        │                         │       queue follow-up   │
        │                         └───────────┬─────────────┘
        │                                     │
        │                         ┌───────────┴─────────┐
        │                  PATH A │ Self-dispatch        │
        │                         │ signal-inbox tick    │
        │                         │   causeType=         │
        │                         │     daemon_terminal  │
        │                         │       ▼              │
        │                         │ State = implementing │
        │                         │ NOT in suppressed    │
        │                         │ set ✓                │
        │                         │       ▼              │
        │                         │ prNumber exists ✓    │
        │                         │       ▼              │
        │                         │ Build self-dispatch  │
        │                         │ payload              │
        │                         │       ▼              │
        │                         │ Return in HTTP       │
        │                         │ response body        │
        │                         └───────────┬─────────┘
        │                                     │
        ▼                                     ▼
  Daemon receives               Daemon calls runCommand()
  selfDispatch payload          with synthetic input
        │                               │
        └───────────────────────────────►│
                                        ▼
                                  Agent starts reviewing
                                  ✓ SUCCESS
```

### 2.4 Self-Dispatch Flow (Detailed)

```
┌─────────────┐     POST /api/daemon-event      ┌───────────────────┐
│   DAEMON    │ ──────────────────────────────►  │  daemon-event     │
│ (sandbox)   │     { messages, threadId, ... }  │  route.ts         │
│             │                                  │                   │
│             │                                  │  1. handleDaemon  │
│             │                                  │     Event()       │
│             │                                  │  2. SDLC signal   │
│             │                                  │     inbox tick    │
│             │                                  │  3. Prepare       │
│             │     HTTP 200 Response            │     selfDispatch  │
│             │  ◄──────────────────────────────  │     payload      │
│             │     { selfDispatch: {...} }       │                   │
│             │                                  └───────────────────┘
│             │
│ parse       │
│ selfDispatch│
│ from body   │
│      │      │
│      ▼      │
│ runCommand  │
│ (synthetic) │──► spawn agent CLI process
│             │
└─────────────┘
```

### 2.5 Transport Modes

| Mode               | Agents                           | Description                                                                     |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------- |
| `legacy`           | All                              | Daemon spawns agent CLI via shell, parses stdout line-by-line.                  |
| `acp`              | claudeCode, codex, amp, opencode | Agent Collaboration Protocol via sandbox-agent HTTP server. SSE streaming.      |
| `codex-app-server` | codex only                       | Daemon manages a persistent Codex app-server process, sends turns via JSON-RPC. |

Transport mode is computed in `startAgentMessage.ts` at dispatch time and stored in `agentRunContext`. Self-dispatch inherits the stored `transportMode` from the previous run context.

### 2.6 SDLC State Machine

```
                    ┌──────────────────────────────────────────────────────┐
                    │                  GLOBAL TRANSITIONS                  │
                    │  pr_closed_unmerged → terminated_pr_closed           │
                    │  pr_merged         → terminated_pr_merged            │
                    │  manual_stop       → stopped                        │
                    │  human_feedback_requested → blocked_on_human_feedback│
                    └──────────────────────────────────────────────────────┘

                           plan_completed
              ┌──────────┐ ──────────────► ┌──────────────┐
              │ planning │                 │ implementing │
              └──┬───────┘                 └──┬───────────┘
                 │ ▲                          │ ▲
                 │ │ plan_gate_blocked        │ │ implementation_gate_blocked
                 └─┘                         │ │ implementation_progress
                                             │ └─────────────────────────┐
                          implementation_    │                           │
                          completed         │                           │
                           ┌────────────────┘   review_blocked          │
                           ▼                    deep/carmack_blocked     │
                    ┌───────────┐ ─────────────────────────────────────►│
                    │ reviewing │                                       │
                    └──┬────────┘                                       │
                       │                                                │
                       │ review_passed                                  │
                       ▼                                                │
                    ┌────────────┐  ui_smoke_failed ───────────────────►│
                    │ ui_testing │  video_capture_failed ──────────────►│
                    └──┬─────────┘                                      │
                       │                                                │
                       │ pr_linked / video_capture_succeeded            │
                       ▼                                                │
                    ┌───────────────┐  babysit_blocked ────────────────►│
                    │ pr_babysitting│  ci_gate_blocked ────────────────►│
                    └──┬────────────┘  review_threads_gate_blocked ────►│
                       │                                                │
                       │ babysit_passed / mark_done                     │
                       ▼                                                │
                    ┌──────┐                                            │
                    │ done │                                            │
                    └──────┘                                            │
```

---

## 3. Root Causes (Detailed)

### RC-1: `fastResume` skips daemon health check

**File:** `packages/sandbox/src/setup.ts`, `setupSandboxEveryTime`, line ~371

```typescript
if (!isCreatingSandbox && !options.fastResume) {
  parallelOps.push(
    options.autoUpdateDaemon
      ? (async () => {
          await updateDaemonIfOutdated({ session, options });
          await restartDaemonIfNotRunning({ session, options });
        })()
      : restartDaemonIfNotRunning({ session, options }),
  );
}
```

The `!options.fastResume` guard causes the entire daemon health/update block to be skipped. `restartDaemonIfNotRunning` is cheap — it sends a ping, and returns immediately if alive. But `fastResume` was designed to skip expensive operations (agent file updates, daemon binary updates). The health check was accidentally swept into the same guard.

**Impact:** Every queue-based SDLC dispatch goes through `startAgentMessage` → `getSandboxForThreadOrNull(fastResume: true)` → `setupSandboxEveryTime`. If the daemon died between phases, the follow-up message is sent to a dead socket. All 4 retries in `sendMessage` fail.

### RC-2: Silent spawn failure (`null !== undefined`)

**File:** `packages/daemon/src/daemon.ts`, `handleProcessClose`, line ~2665

```typescript
const activeState = this.activeProcesses.get(threadChatId);
if (!activeState || activeState.processId !== processId) {
    this.runtime.logger.info("Process closed but not handled", { ... });
    return;
}
```

When `spawn()` fails, `child.pid` is `undefined`. When a new process state is initialized in `runCommand`, `processId` is set to `null`. The strict inequality `null !== undefined` evaluates to `true`, causing early return. Error-reporting code never executes. Thread stays "working" forever.

### RC-3: Self-dispatch errors are fire-and-forget

**File:** `packages/daemon/src/daemon.ts`, line ~3531

```typescript
this.runCommand(syntheticInput).catch((error) => {
  this.runtime.logger.error("SDLC self-dispatch failed", {
    error: formatError(error),
  });
});
```

If `runCommand` fails (e.g., spawn failure, transport error), the error is logged to the daemon's local log file but never reported to the server. Thread stays "working" with no user-visible error.

### RC-4: `planning` state suppresses `daemon_terminal` signals

**File:** `apps/www/src/server-lib/sdlc-loop/signal-inbox.ts`, line ~51

```typescript
const nonBabysitFeedbackSuppressedStates: ReadonlySet<SdlcLoopState> = new Set([
  "planning",
]);
```

All feedback signal cause types (including `daemon_terminal`) are suppressed when loop is in `planning` state. Intended to prevent PR review feedback during planning, but also blocks the `daemon_terminal` signal that triggers self-dispatch.

### RC-5: `prNumber` guard blocks self-dispatch routing

**File:** `apps/www/src/server-lib/sdlc-loop/signal-inbox.ts`, line ~1125

```typescript
if (
    feedbackSignalCauseTypes.has(signal.causeType) &&
    shouldQueueRuntimeFollowUp &&
    !shouldSuppressFeedbackRuntimeAction &&
    typeof loop.prNumber === "number"
)
```

`loop.prNumber` is `null` during planning (no PR exists). This guard blocks routing even after fixing RC-4.

### RC-6: No unhandled rejection/exception handlers in daemon

**File:** `packages/daemon/src/index.ts`

No `process.on('unhandledRejection', ...)` or `process.on('uncaughtException', ...)`. Any unhandled promise rejection or synchronous exception kills the daemon silently. No error reported to server. Combined with RC-1, next dispatch finds dead daemon.

### RC-7: All errors become `"agent-not-responding"`

**File:** `apps/www/src/agent/daemon.ts`, line ~147

```typescript
const errorType = isInfrastructureError(error)
  ? "unknown-error"
  : "agent-not-responding";
throw wrapError(errorType, error);
```

Every non-infrastructure error from `sendDaemonMessage` is classified as `"agent-not-responding"`. No diagnostic signal to distinguish daemon-dead vs spawn-failure vs transport-mismatch.

---

## 4. Target Architecture (To-Be)

### 4.1 Design Principles

1. **Never skip daemon health checks** — `restartDaemonIfNotRunning` is a cheap ping. It runs on every resume.
2. **Self-dispatch should work for all phase transitions** — The daemon is already alive, so self-dispatch avoids the queue-based path entirely.
3. **Errors must be classified, not generic** — Different failure modes need different remediation strategies.
4. **Gate evaluations should not depend on daemon liveness** — Review gates run Codex CLI directly on the sandbox, independent of the Terragon daemon.
5. **Silent failures are unacceptable** — Every failure must produce a user-visible error or trigger automated recovery.

### 4.2 Two Execution Classes

```
┌─────────────────────────────────────────────────────────────┐
│                    SDLC LOOP CONTROLLER                     │
│                                                             │
│  Execution Policy Resolver                                  │
│  ┌───────────────┐        ┌──────────────────────────────┐  │
│  │ phase state   │───────►│ SdlcExecutionPolicy          │  │
│  │ agent type    │        │ { runtime, requiresDaemon,   │  │
│  │ capabilities  │        │   supportsStreaming,          │  │
│  └───────────────┘        │   transportMode }            │  │
│                           └─────────────┬────────────────┘  │
│                                         │                   │
│               ┌─────────────────────────┼──────────────┐    │
│               ▼                         ▼              │    │
│  ┌────────────────────┐   ┌────────────────────────┐   │    │
│  │ IMPLEMENTATION     │   │ GATE RUNTIME           │   │    │
│  │ RUNTIME            │   │                        │   │    │
│  │                    │   │ Phases:                │   │    │
│  │ Phases:            │   │  - reviewing           │   │    │
│  │  - planning        │   │  - ci                  │   │    │
│  │  - implementing    │   │  - ui_testing          │   │    │
│  │                    │   │                        │   │    │
│  │ Characteristics:   │   │ Characteristics:       │   │    │
│  │  - Daemon-managed  │   │  - Direct sandbox exec │   │    │
│  │  - Streamed output │   │  - Structured output   │   │    │
│  │  - Sub-agents OK   │   │  - Independent retry   │   │    │
│  │  - Long-running    │   │  - No daemon needed    │   │    │
│  │                    │   │  - Deterministic        │   │    │
│  │ Transport:         │   │                        │   │    │
│  │  Codex: codex-app- │   │ Executor:              │   │    │
│  │    server           │   │  session.runCommand()  │   │    │
│  │  Claude: legacy    │   │                        │   │    │
│  └────────────────────┘   └────────────────────────┘   │    │
│                                                         │    │
└─────────────────────────────────────────────────────────┘    │
```

### 4.3 Target Dispatch Flow (Planning → Implementing)

```
Agent completes planning
        │
        ▼
Daemon sends terminal messages ──► POST /api/daemon-event
        │                                    │
        │                         ┌──────────┴───────────────────┐
        │                         │ 1. handleDaemonEvent()       │
        │                         │ 2. checkpointThread()        │
        │                         │    - planning gate eval      │
        │                         │    - state transition        │
        │                         │    - queue follow-up         │
        │                         │ 3. Signal inbox tick         │
        │                         │    - daemon_terminal NOT     │
        │                         │      suppressed (fixed)      │
        │                         │    - prNumber guard bypassed │
        │                         │      for daemon_terminal     │
        │                         │ 4. Self-dispatch payload     │
        │                         │    constructed ✓             │
        │                         └──────────┬───────────────────┘
        │                                    │
        │         HTTP 200 { selfDispatch }  │
        │  ◄─────────────────────────────────┘
        │
        ▼
  ┌─────────────────────┐
  │ Daemon receives     │
  │ selfDispatch payload│
  │      │              │
  │      ▼              │
  │ runCommand()        │──── on error ──► addMessageToBuffer()
  │      │              │                  { type: "custom-error" }
  │      ▼              │                  flushMessageBuffer()
  │ Agent starts        │                       │
  │ implementing phase  │                       ▼
  │                     │               Server receives error
  │ ✓ SUCCESS           │               SDLC auto-retry kicks in
  └─────────────────────┘
```

### 4.4 Target Dispatch Flow (Queue Fallback — With Health Check)

```
Self-dispatch failed (or not available)
        │
        ▼
maybeProcessFollowUpQueue()
        │
        ▼
startAgentMessage()
        │
        ▼
getSandboxForThreadOrNull(fastResume: true)
        │
        ▼
setupSandboxEveryTime()
        │
        ├──► [ALWAYS] restartDaemonIfNotRunning()
        │              │
        │              ├── ping daemon ──► alive? return immediately
        │              │
        │              └── dead? ──► kill remnants
        │                          ──► startDaemon()
        │                          ──► waitForDaemonReady()
        │
        ▼
sendDaemonMessage()
        │
        ▼
sendMessage() ──► daemon is alive ──► ✓ SUCCESS
```

### 4.5 Error Classification Hierarchy

```
                        ┌──────────────────────┐
                        │    ThreadError        │
                        │    (base class)       │
                        └──────────┬───────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
  ┌────────┴─────────┐  ┌─────────┴──────────┐  ┌────────┴──────────┐
  │ Infrastructure   │  │ Daemon Errors      │  │ Agent Errors      │
  │                  │  │                    │  │                    │
  │ unknown-error    │  │ daemon-unreachable │  │ agent-not-         │
  │ (DB, internal)   │  │ daemon-spawn-      │  │   responding      │
  │                  │  │   failed           │  │ agent-generic-    │
  │                  │  │ sdlc-dispatch-     │  │   error           │
  │                  │  │   failed           │  │                    │
  └──────────────────┘  └────────────────────┘  └────────────────────┘

Classification logic in sendDaemonMessage (apps/www/src/agent/daemon.ts):

  isInfrastructureError(error) → "unknown-error"
  isDaemonSocketError(error)   → "daemon-unreachable"    ← NEW
  isDaemonSpawnError(error)    → "daemon-spawn-failed"   ← NEW
  isSdlcDispatchError(error)   → "sdlc-dispatch-failed"  ← NEW
  default                      → "agent-not-responding"
```

### 4.6 Component Interaction Diagram (Target)

```
┌──────────────────────────────────────────────────────────────────────┐
│                           SANDBOX                                    │
│                                                                      │
│  ┌─────────────────┐    ┌────────────────────┐                       │
│  │  DAEMON          │    │  AGENT CLI          │                      │
│  │  (terragon-      │───►│  (claude/codex/amp) │                      │
│  │   daemon.mjs)    │    └────────────────────┘                       │
│  │                  │                                                │
│  │  Capabilities:   │    ┌────────────────────┐                       │
│  │  - sdlc_self_    │    │  GATE EXECUTOR      │ ◄── NEW: runs       │
│  │    dispatch      │    │  (codex CLI direct) │     independently   │
│  │  - event_        │    └────────────────────┘     of daemon        │
│  │    envelope_v2   │                                                │
│  │                  │    ┌────────────────────┐                       │
│  │  Process         │    │  SANDBOX-AGENT      │                      │
│  │  handlers:       │    │  (ACP transport)    │                      │
│  │  - unhandled     │    └────────────────────┘                       │
│  │    Rejection ◄── NEW                                              │
│  │  - uncaught      │                                                │
│  │    Exception ◄── NEW                                              │
│  └─────────────────┘                                                 │
│                                                                      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                    POST /api/daemon-event
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           SERVER                                     │
│                                                                      │
│  ┌──────────────────┐   ┌────────────────────┐   ┌───────────────┐  │
│  │ daemon-event     │──►│ handle-daemon-     │──►│ checkpoint-   │  │
│  │ route.ts         │   │ event.ts           │   │ thread-       │  │
│  │                  │   │                    │   │ internal.ts   │  │
│  │ Self-dispatch    │   │ SDLC error recovery│   │               │  │
│  │ payload builder  │   │ Error classification│  │ Phase gates   │  │
│  │                  │   │                    │   │ State          │  │
│  │ Signal inbox     │   └────────────────────┘   │ transitions   │  │
│  │ tick             │                            │ Follow-up     │  │
│  └────────┬─────────┘                            │ queue         │  │
│           │                                      └───────────────┘  │
│           ▼                                                          │
│  ┌──────────────────┐   ┌────────────────────┐                      │
│  │ signal-inbox.ts  │   │ execution-policy.ts│ ◄── NEW              │
│  │                  │   │                    │                      │
│  │ Routing:         │   │ Resolves runtime   │                      │
│  │ - daemon_terminal│   │ for each phase:    │                      │
│  │   NOT suppressed │   │ plan/impl → daemon │                      │
│  │   for any active │   │ review/ci → gate   │                      │
│  │   phase          │   └────────────────────┘                      │
│  │ - prNumber NOT   │                                                │
│  │   required for   │   ┌────────────────────┐                      │
│  │   daemon_terminal│   │ gate-executor.ts   │ ◄── NEW              │
│  └──────────────────┘   │                    │                      │
│                         │ Runs gate evals    │                      │
│                         │ via direct sandbox │                      │
│                         │ commands           │                      │
│                         └────────────────────┘                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Detailed Design

### 5.1 Fix `fastResume` Skipping Daemon Health Check

**Current:** `packages/sandbox/src/setup.ts:371` — `fastResume=true` skips entire daemon health block.

**Target:** `fastResume` skips expensive operations (agent file updates, daemon binary updates) but ALWAYS runs `restartDaemonIfNotRunning`. The ping is ~50ms on the happy path.

```typescript
// Target code
if (!isCreatingSandbox) {
  if (!options.fastResume && options.autoUpdateDaemon) {
    parallelOps.push(
      (async () => {
        await updateDaemonIfOutdated({ session, options });
        await restartDaemonIfNotRunning({ session, options });
      })(),
    );
  } else {
    parallelOps.push(restartDaemonIfNotRunning({ session, options }));
  }
}
```

**Migration:** Direct code change. No feature flag needed. Strictly additive — adds a health check that was previously missing.

### 5.2 Fix Silent Spawn Failure (`null !== undefined`)

**Current:** `packages/daemon/src/daemon.ts:2665` — `null !== undefined` → `true` → early return.

**Target:** Treat both nullish values as equivalent:

```typescript
if (!activeState || (activeState.processId != null && activeState.processId !== processId)) {
```

When both are nullish (spawn failed), fall through to error reporting.

### 5.3 Report Self-Dispatch Errors to Server

**Current:** `packages/daemon/src/daemon.ts:3531` — `.catch()` only logs locally.

**Target:** Send `custom-error` message to server:

```typescript
this.runCommand(syntheticInput).catch(async (error) => {
  this.runtime.logger.error("SDLC self-dispatch failed", {
    error: formatError(error),
  });
  this.addMessageToBuffer({
    agent: syntheticInput.agent,
    message: {
      type: "custom-error",
      session_id: null,
      duration_ms: 0,
      error_info: `SDLC self-dispatch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    },
    threadId: syntheticInput.threadId,
    threadChatId: syntheticInput.threadChatId,
    token: syntheticInput.token,
  });
  await this.flushMessageBuffer();
});
```

### 5.4 Enable Self-Dispatch for Planning → Implementing

**File:** `apps/www/src/server-lib/sdlc-loop/signal-inbox.ts`

**Change 1 (line ~51):** Make suppression granular — suppress PR feedback during planning but NOT `daemon_terminal`:

```typescript
const shouldSuppressFeedbackRuntimeAction =
  feedbackSignalCauseTypes.has(signal.causeType) &&
  signal.causeType !== "daemon_terminal" &&
  nonBabysitFeedbackSuppressedStates.has(loop.state);
```

**Change 2 (line ~1125):** Add parallel branch for `daemon_terminal` that doesn't require `prNumber`:

```typescript
if (
    signal.causeType === "daemon_terminal" &&
    shouldQueueRuntimeFollowUp &&
    !shouldSuppressFeedbackRuntimeAction
) {
    // daemon_terminal signals don't need a PR to route
    const routeResult = await routeFeedbackSignalToEnrolledThread({ ... });
    runtimeAction = "feedback_follow_up_queued";
    feedbackQueuedMessage = routeResult.queuedMessage;
} else if (
    feedbackSignalCauseTypes.has(signal.causeType) &&
    shouldQueueRuntimeFollowUp &&
    !shouldSuppressFeedbackRuntimeAction &&
    typeof loop.prNumber === "number"
) { /* existing PR feedback path */ }
```

### 5.5 Execution Policy Resolver

**New file:** `apps/www/src/server-lib/sdlc-loop/execution-policy.ts`

```typescript
export type SdlcExecutionRuntime = "implementation" | "gate";

export type SdlcExecutionPolicy = {
  runtime: SdlcExecutionRuntime;
  requiresDaemon: boolean;
  supportsStreaming: boolean;
  supportsSubAgents: boolean;
  transportMode: "legacy" | "acp" | "codex-app-server";
};

export function resolveExecutionPolicy(params: {
  phase: SdlcLoopState;
  agent: AIAgent;
  capabilities: Set<string>;
}): SdlcExecutionPolicy {
  const { phase, agent } = params;

  // Implementation runtime phases
  if (phase === "planning" || phase === "implementing") {
    return {
      runtime: "implementation",
      requiresDaemon: true,
      supportsStreaming: true,
      supportsSubAgents: agent === "codex",
      transportMode: agent === "codex" ? "codex-app-server" : "legacy",
    };
  }

  // Gate runtime phases
  if (phase === "reviewing" || phase === "ui_testing") {
    return {
      runtime: "gate",
      requiresDaemon: false,
      supportsStreaming: false,
      supportsSubAgents: false,
      transportMode: "legacy", // direct sandbox exec, not daemon transport
    };
  }

  // PR babysitting — hybrid (mostly gate-like checks + daemon for fixes)
  return {
    runtime: "implementation",
    requiresDaemon: true,
    supportsStreaming: true,
    supportsSubAgents: false,
    transportMode: agent === "codex" ? "codex-app-server" : "legacy",
  };
}
```

**Usage in self-dispatch** (`daemon-event/route.ts`): Replace stale `transportMode` inheritance:

```typescript
// Current (inherits stale value):
const transportMode = (runContext?.transportMode as ...) ?? "legacy";

// Target (recomputes from policy):
const policy = resolveExecutionPolicy({ phase: loop.state, agent, capabilities });
const transportMode = policy.transportMode;
```

### 5.6 Gate Runtime Executor

**New file:** `apps/www/src/server-lib/sdlc-loop/gate-executor.ts`

Abstracts the pattern already used by `carmack-review-gate.ts` and `deep-review-gate.ts`:

```typescript
export type GateResult = {
  passed: boolean;
  findings: GateFinding[];
  rawOutput: string;
  durationMs: number;
  error?: string;
};

export async function executeGate(params: {
  session: ISandboxSession;
  gateType: "deep_review" | "carmack_review" | "ci_evaluation" | "ui_smoke";
  prompt: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<GateResult> {
  // Direct sandbox command execution — no daemon dependency
  // Structured JSON output parsing
  // Independent retry on failure
}
```

### 5.7 Daemon Resilience

**`packages/daemon/src/index.ts`** — Add process handlers:

```typescript
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in daemon:", reason);
  // DO NOT exit — daemon should be resilient to individual promise failures
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception in daemon:", error);
  // Exit — state may be corrupted. restartDaemonIfNotRunning will restart.
  process.exit(1);
});
```

**`packages/sandbox/src/daemon.ts`** — Guard daemon update against active processes:

```typescript
// In updateDaemonIfOutdated, before sendKillMessage:
// Check if daemon has active processes by pinging with a status request
// If active, defer update
```

---

## 6. Phased Implementation Plan

### Phase 1 (P0): Stop the Bleeding — 1-2 days

All fixes are parallelizable.

| Task | File                                 | Function                | Description                                                                |
| ---- | ------------------------------------ | ----------------------- | -------------------------------------------------------------------------- |
| 1.1  | `packages/sandbox/src/setup.ts:371`  | `setupSandboxEveryTime` | Always run `restartDaemonIfNotRunning`, only skip updates for `fastResume` |
| 1.2  | `packages/daemon/src/daemon.ts:2665` | `handleProcessClose`    | Fix `null !== undefined` with loose inequality                             |
| 1.3  | `packages/daemon/src/daemon.ts:3531` | `flushMessageBuffer`    | Report self-dispatch errors via `custom-error` message                     |

**Dependencies:** 1.3 depends on 1.2 (spawn failures need to produce catchable errors).

### Phase 2 (P1): Enable Self-Dispatch for All Transitions — 1 day

Sequential tasks.

| Task | File                   | Function          | Description                                                |
| ---- | ---------------------- | ----------------- | ---------------------------------------------------------- |
| 2.1  | `signal-inbox.ts:51`   | Suppression check | Make granular: suppress PR feedback, not `daemon_terminal` |
| 2.2  | `signal-inbox.ts:1125` | Routing guard     | Add branch for `daemon_terminal` without `prNumber`        |

**Dependencies:** 2.2 depends on 2.1.

### Phase 3 (P1): Error Classification & Observability — 1-2 days

Parallel with Phase 2.

| Task | File                                          | Description                                                             |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 3.1a | `packages/shared/src/db/types.ts`             | Add `daemon-unreachable`, `daemon-spawn-failed`, `sdlc-dispatch-failed` |
| 3.1b | `apps/www/src/agent/daemon.ts:147`            | Classify errors with pattern matchers                                   |
| 3.1c | `apps/www/src/agent/error.ts`                 | Add to `allThreadErrors` map                                            |
| 3.1d | `apps/www/src/components/chat/chat-error.tsx` | Phase-aware error rendering                                             |
| 3.2  | `apps/www/src/app/api/daemon-event/route.ts`  | PostHog captures for self-dispatch outcomes                             |

### Phase 4 (P2): Execution Class Separation — 3-5 days

| Task | File                        | Description                                       |
| ---- | --------------------------- | ------------------------------------------------- |
| 4.1  | `execution-policy.ts` (NEW) | Execution policy resolver                         |
| 4.2  | `gate-executor.ts` (NEW)    | Centralized gate runtime                          |
| 4.3  | `daemon-event/route.ts`     | Runtime-aware failure metadata on terminal events |
| 4.4  | `daemon-event/route.ts`     | Self-dispatch recomputes transport from policy    |
| 4.5  | Multiple                    | Codex SDLC never selects ACP transport            |

### Phase 5 (P2): Daemon Resilience — 1-2 days

| Task | File                                 | Description                                             |
| ---- | ------------------------------------ | ------------------------------------------------------- |
| 5.1  | `packages/daemon/src/index.ts:186`   | Add unhandled rejection/exception handlers              |
| 5.2  | TBD (Daytona SDK)                    | Daemon keepalive pings to prevent session GC            |
| 5.3  | `packages/sandbox/src/daemon.ts:199` | Guard `updateDaemonIfOutdated` against active processes |

---

## 7. Testing Strategy

### 7.1 Unit Tests

| Fix | Test                                                                                             | Location                             |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 1.1 | `setupSandboxEveryTime` calls `restartDaemonIfNotRunning` with `fastResume: true`                | `packages/sandbox/src/setup.test.ts` |
| 1.2 | `handleProcessClose` reports error when processId is undefined and activeState.processId is null | `packages/daemon/src/daemon.test.ts` |
| 1.3 | Self-dispatch catch adds `custom-error` to buffer and flushes                                    | `packages/daemon/src/daemon.test.ts` |
| 2.1 | `daemon_terminal` signals NOT suppressed during `planning`                                       | `signal-inbox.test.ts`               |
| 2.2 | Feedback routing works for `daemon_terminal` when `prNumber === null`                            | `signal-inbox.test.ts`               |
| 3.1 | Error classification produces correct types for socket/spawn/dispatch errors                     | `apps/www/src/agent/daemon.test.ts`  |
| 4.1 | Policy resolver maps all phases correctly                                                        | `execution-policy.test.ts`           |

### 7.2 Integration Tests

| Scenario                                                               | Validates           |
| ---------------------------------------------------------------------- | ------------------- |
| Queue dispatch with dead daemon → daemon restarted → message delivered | Phase 1 (1.1)       |
| Self-dispatch for planning→implementing                                | Phase 2 (2.1 + 2.2) |
| Spawn failure produces visible error in thread                         | Phase 1 (1.2)       |
| Gate execution when daemon is dead                                     | Phase 4 (4.2)       |

### 7.3 E2E Test

Full Planning→Implementing transition:

1. Create thread with SDLC loop in `planning` state
2. Send planning completion (daemon terminal messages)
3. Verify loop transitions to `implementing`
4. Verify follow-up is dispatched (self-dispatch or queue)
5. Verify implementing agent starts

**Kill variant:** Kill daemon between planning and implementing. Verify queue path restarts daemon.

---

## 8. Rollout Plan

### 8.1 Feature Flags

| Flag                       | Phase   | Default | Purpose                                           |
| -------------------------- | ------- | ------- | ------------------------------------------------- |
| None                       | Phase 1 | N/A     | Bug fixes, ship directly                          |
| `sdlcSelfDispatchPlanning` | Phase 2 | `false` | Gate self-dispatch for planning→implementing      |
| `sdlcClassifiedErrors`     | Phase 3 | `false` | Enable new error type classification              |
| `sdlcExecutionClasses`     | Phase 4 | `false` | Enable execution policy resolver and gate runtime |

### 8.2 Monitoring

PostHog events to add:

- `sdlc_self_dispatch_prepared` — success, with `loopState`
- `sdlc_self_dispatch_skipped` — with `reason`, `loopState`
- `sdlc_self_dispatch_failed` — with `error`, `loopState`
- `sdlc_daemon_restart_on_resume` — when restart actually fires
- `sdlc_spawn_failure_reported` — when handleProcessClose catches spawn failure

Dashboard metrics:

- Rate of `agent-not-responding` (should decrease after Phase 1)
- Self-dispatch success rate by loop state (should reach ~100% after Phase 2)
- Phase transition latency (should improve with self-dispatch)

### 8.3 Rollback

- **Phase 1:** Revert PRs. No state migration.
- **Phase 2:** Disable `sdlcSelfDispatchPlanning`. Queue path (now fixed) remains.
- **Phase 3:** Disable `sdlcClassifiedErrors`. Falls back to generic errors.
- **Phase 4:** Disable `sdlcExecutionClasses`. Falls back to unified dispatch.

---

## 9. Risks & Mitigations

| Risk                                                     | Phase | Likelihood | Impact | Mitigation                                                                                |
| -------------------------------------------------------- | ----- | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| `restartDaemonIfNotRunning` adds latency to resume       | P1    | Medium     | Low    | Ping is ~50ms. Only restarts if dead (~15s). Happy path adds ~50ms.                       |
| Self-dispatch during planning races with follow-up queue | P2    | Medium     | Medium | Status transition CAS prevents double-dispatch. Feature-flagged for incremental rollout.  |
| New error types break error handling UI                  | P3    | Low        | Medium | New types extend union additively. Fallback to generic rendering.                         |
| Gate runtime separation changes checkpoint behavior      | P4    | Medium     | High   | Feature-flagged. Existing path preserved as fallback.                                     |
| `handleProcessClose` fix affects working flows           | P1    | Low        | Low    | Only affects `null`/`undefined` case (spawn failures), which currently produce no output. |

---

## 10. Acceptance Criteria

### Phase 1

- [ ] Planning→Implementing succeeds when daemon died between phases
- [ ] Spawn failures produce visible error messages
- [ ] Self-dispatch failures reported to server as `custom-error`
- [ ] No regression on existing resume flows (latency < 100ms added)

### Phase 2

- [ ] Self-dispatch fires for Planning→Implementing (`sdlc_self_dispatch_prepared` event)
- [ ] No regression on existing self-dispatch (Implementing→Reviewing)
- [ ] PR review feedback still suppressed during planning

### Phase 3

- [ ] New error types appear in logs when appropriate
- [ ] Chat error UI shows phase-aware messages
- [ ] PostHog captures fire for self-dispatch outcomes

### Phase 4

- [ ] Policy resolver maps all phases correctly
- [ ] Gates run when daemon is dead
- [ ] Codex SDLC never selects ACP
- [ ] Self-dispatch recomputes transport from policy

### Phase 5

- [ ] Daemon survives unhandled promise rejections
- [ ] Daemon exits on uncaught exceptions (and is restarted)
- [ ] Daemon update doesn't kill daemon with active processes

---

## 11. Appendix

### A. Full File Reference

| File                                                     | Fixes                                 |
| -------------------------------------------------------- | ------------------------------------- |
| `packages/sandbox/src/setup.ts:371`                      | 1.1: fastResume skips daemon restart  |
| `packages/daemon/src/daemon.ts:2665`                     | 1.2: null !== undefined spawn failure |
| `packages/daemon/src/daemon.ts:3531`                     | 1.3: self-dispatch error swallowed    |
| `apps/www/src/server-lib/sdlc-loop/signal-inbox.ts:51`   | 2.1: planning suppression             |
| `apps/www/src/server-lib/sdlc-loop/signal-inbox.ts:1125` | 2.2: prNumber guard                   |
| `apps/www/src/agent/daemon.ts:147`                       | 3.1: generic error wrapping           |
| `apps/www/src/app/api/daemon-event/route.ts:806`         | 3.2: self-dispatch gate               |
| `packages/daemon/src/index.ts:186`                       | 5.1: no rejection handlers            |
| `packages/sandbox/src/daemon.ts:199`                     | 5.3: daemon update race               |

### B. SDLC State Transition Table

| Current State    | Event                         | Next State                  |
| ---------------- | ----------------------------- | --------------------------- |
| `planning`       | `plan_completed`              | `implementing`              |
| `planning`       | `plan_gate_blocked`           | `planning`                  |
| `implementing`   | `implementation_progress`     | `implementing`              |
| `implementing`   | `implementation_gate_blocked` | `implementing`              |
| `implementing`   | `implementation_completed`    | `reviewing`                 |
| `reviewing`      | `review_blocked`              | `implementing`              |
| `reviewing`      | `deep_review_gate_blocked`    | `implementing`              |
| `reviewing`      | `carmack_review_gate_blocked` | `implementing`              |
| `reviewing`      | `review_passed`               | `ui_testing`                |
| `ui_testing`     | `ui_smoke_failed`             | `implementing`              |
| `ui_testing`     | `video_capture_failed`        | `implementing`              |
| `ui_testing`     | `pr_linked`                   | `pr_babysitting`            |
| `ui_testing`     | `video_capture_succeeded`     | `pr_babysitting`            |
| `pr_babysitting` | `babysit_blocked`             | `implementing`              |
| `pr_babysitting` | `ci_gate_blocked`             | `implementing`              |
| `pr_babysitting` | `review_threads_gate_blocked` | `implementing`              |
| `pr_babysitting` | `babysit_passed`              | `done`                      |
| `pr_babysitting` | `mark_done`                   | `done`                      |
| Any non-terminal | `pr_closed_unmerged`          | `terminated_pr_closed`      |
| Any non-terminal | `pr_merged`                   | `terminated_pr_merged`      |
| Any non-terminal | `manual_stop`                 | `stopped`                   |
| Any non-terminal | `human_feedback_requested`    | `blocked_on_human_feedback` |

### C. Error Type Taxonomy

| Error Type                   | Cause                                | User Message                | Recovery                       |
| ---------------------------- | ------------------------------------ | --------------------------- | ------------------------------ |
| `agent-not-responding`       | Daemon alive but agent CLI no output | "Agent did not respond"     | Retry                          |
| `daemon-unreachable` (NEW)   | Daemon process dead, socket errors   | "Sandbox agent unreachable" | Auto-restart, retry            |
| `daemon-spawn-failed` (NEW)  | Agent CLI failed to spawn            | "Agent failed to start"     | Check sandbox health           |
| `sdlc-dispatch-failed` (NEW) | Phase transition dispatch failed     | "Phase transition failed"   | Auto-retry with fresh dispatch |
| `unknown-error`              | Infrastructure (DB, internal)        | "Unexpected error"          | Report bug                     |
| `sandbox-not-found`          | Sandbox expired                      | "Sandbox not found"         | Create new                     |
| `sandbox-resume-failed`      | Provider error on resume             | "Failed to resume"          | Retry or create new            |
