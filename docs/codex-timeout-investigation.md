# Codex Timeout & Reliability Investigation

> **Date**: 2026-03-03
> **Status**: Active investigation
> **Impact**: Codex agent tasks fail ~30-50% of the time on multi-turn tool use
>
> **Superseded for Codex transport:** This document covers the ACP transport path. The newer `codex-app-server` transport replaces ACP for Codex when `codexAppServerTransport` is enabled.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [The Timeout Chain](#the-timeout-chain)
4. [Root Causes](#root-causes)
5. [What We've Fixed So Far](#what-weve-fixed-so-far)
6. [Known Issues We Cannot Fix](#known-issues-we-cannot-fix)
7. [Config.toml Nesting Bug](#configtoml-nesting-bug)
8. [Dead Subprocess Caching](#dead-subprocess-caching)
9. [Error Surface Area](#error-surface-area)
10. [Competitor Approaches](#competitor-approaches)
11. [Recommended Next Steps](#recommended-next-steps)
12. [Appendix: Full Message Flow Timeline](#appendix-full-message-flow-timeline)
13. [References](#references)

---

## Executive Summary

Codex tasks in Leo fail due to a cascade of timeout mismatches across 5 layers. The primary root causes are:

1. **OpenAI API stream disconnects** — gpt-5.2-codex and gpt-5.3-codex models have a 30-50% failure rate on iteration 2+ of the agent loop (multi-turn tool use). Streams terminate without a `response.completed` event.

2. **sandbox-agent's ACP proxy timeout was 120s** — Complex coding tasks routinely take 3-10+ minutes. When the OpenAI API takes longer than 120s to respond, sandbox-agent returns a 504 to our daemon. **We've bumped this to 600s (10 min).**

3. **Our config.toml is likely at the wrong TOML nesting level** — The `stream_idle_timeout_ms`, `request_max_retries`, and `stream_max_retries` values we wrote to `/root/.codex/config.toml` are at the TOML root level, but codex_core expects them under `[model_providers.<id>]`. They are likely silently ignored, meaning the much lower defaults (5 min idle, 4 retries, 5 stream retries) are in effect.

4. **`request_max_retries` cannot be overridden for the built-in OpenAI provider** — This is "by design" per OpenAI ([Issue #3026](https://github.com/openai/codex/issues/3026)). Only custom model providers honor this setting.

5. **Dead subprocess caching in sandbox-agent** — When codex-acp crashes, sandbox-agent keeps the dead instance cached. Subsequent requests fail with write errors or timeouts instead of spawning a fresh process.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Leo Daemon                               │
│  (Node.js, runs inside sandbox)                                      │
│                                                                      │
│  ┌──────────────┐     ┌──────────────┐     ┌────────────────────┐   │
│  │ Unix Socket   │────▶│ runCommand() │────▶│ ACP Transport      │   │
│  │ (from server) │     │              │     │ (HTTP + SSE)       │   │
│  └──────────────┘     └──────────────┘     └────────┬───────────┘   │
│                                                      │               │
│  Messages buffered ◀──── SSE events ◀────────────────┘               │
│  and POSTed to server    (parsed by acp-codex-adapter.ts)            │
└──────────────────────────────────────────────────────────────────────┘
                                │
                    HTTP POST / SSE GET
                    port 2468
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     sandbox-agent (Rust)                              │
│  @sandbox-agent/cli@0.2.1                                            │
│                                                                      │
│  ┌──────────────────┐     ┌──────────────────────────────────────┐   │
│  │ Axum HTTP Router  │────▶│ AcpProxyRuntime                     │   │
│  │ /v1/acp/{server}  │     │ - Timeout: SANDBOX_AGENT_ACP_       │   │
│  │                   │     │   REQUEST_TIMEOUT_MS (600s)         │   │
│  └──────────────────┘     │ - Caches instances in HashMap       │   │
│                            │ - Does NOT restart dead processes   │   │
│                            └──────────────┬─────────────────────┘   │
│                                           │                          │
│                              JSON-RPC over stdin/stdout               │
│                                           │                          │
│                                           ▼                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │            codex-acp (or @openai/codex directly)               │  │
│  │  @zed-industries/codex-acp (Rust binary)                       │  │
│  │                                                                │  │
│  │  ┌──────────────┐     ┌─────────────────────────────────────┐ │  │
│  │  │ ACP stdio    │────▶│ codex_core (Rust library, in-proc)  │ │  │
│  │  │ JSON-RPC     │     │ - ThreadManager                     │ │  │
│  │  │ listener     │     │ - Config from ~/.codex/config.toml  │ │  │
│  │  └──────────────┘     │ - Responses API (SSE to OpenAI)     │ │  │
│  │                        └──────────────┬──────────────────────┘ │  │
│  └───────────────────────────────────────┼────────────────────────┘  │
└──────────────────────────────────────────┼───────────────────────────┘
                                           │
                              HTTPS SSE (Responses API)
                                           │
                                           ▼
                              ┌─────────────────────┐
                              │   OpenAI API         │
                              │   gpt-5.2-codex      │
                              │   gpt-5.3-codex      │
                              └─────────────────────┘
```

### Key Architectural Facts

- **codex-acp runs codex_core in-process** — It does NOT spawn `codex exec`. It links against the Rust library directly via the `acp` branch of `zed-industries/codex`.
- **sandbox-agent has NO retry logic** — All retry responsibility is delegated to our daemon.
- **sandbox-agent does NOT kill subprocesses on timeout** — It only abandons the pending request. The subprocess continues running.
- **`@zed-industries/codex-acp` is NOT explicitly installed** in our Dockerfile. sandbox-agent resolves it from the codex binary or via npx fallback.
- **Our daemon has two transport modes**: "legacy" (direct `codex exec --json` spawn) and "acp" (via sandbox-agent). ACP is gated behind the `sandboxAgentAcpTransport` feature flag.

---

## The Timeout Chain

There are **7 independent timeout layers** between a user's task and OpenAI's response:

| #   | Layer                               | Timeout              | Controls                                | Our Override                                                        |
| --- | ----------------------------------- | -------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| 1   | OpenAI server-side                  | Undocumented         | Max response generation time            | Cannot control                                                      |
| 2   | OpenAI SSE keepalive                | 30s interval         | Prevents proxy idle disconnects         | Cannot control (only deployed Jan 2026)                             |
| 3   | codex_core `stream_idle_timeout_ms` | 300s (5 min) default | Idle SSE stream before treating as lost | Set to 600s in config.toml — **but likely ignored (wrong nesting)** |
| 4   | codex_core `request_max_retries`    | 4 default            | HTTP request retries                    | Set to 10 — **cannot override for built-in openai provider**        |
| 5   | codex_core `stream_max_retries`     | 5 default            | SSE stream reconnection retries         | Set to 20 — **but likely ignored (wrong nesting)**                  |
| 6   | sandbox-agent ACP proxy             | 120s default         | JSON-RPC request timeout                | **Bumped to 600s** via `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS`       |
| 7   | Daemon SSE inactivity               | 600s (10 min)        | Max silence before declaring timeout    | Set in code (`ACP_SSE_INACTIVITY_TIMEOUT_MS`)                       |

### Daemon-Side Constants

| Constant                           | Value         | Purpose                                          |
| ---------------------------------- | ------------- | ------------------------------------------------ |
| `ACP_REQUEST_TIMEOUT_MS`           | 120s          | Timeout for `initialize` and `session/new` POSTs |
| `ACP_SSE_INACTIVITY_TIMEOUT_MS`    | 600s (10 min) | Max SSE silence before declaring task dead       |
| `ACP_INACTIVITY_CHECK_INTERVAL_MS` | 30s           | Poll interval for inactivity check               |
| `ACP_SSE_RECONNECT_DELAY_MS`       | 150ms base    | Exponential backoff for SSE reconnection         |
| `ACP_SSE_MAX_CONSECUTIVE_FAILURES` | 10            | Circuit breaker threshold                        |
| `ACP_TERMINAL_QUIESCENCE_MS`       | 300ms         | Wait for stream quiet after terminal event       |
| `DEFAULT_HEARTBEAT_INTERVAL_MS`    | 300s (5 min)  | Empty POST to keep sandbox alive                 |
| `IDLE_TIMEOUT_MS` (env)            | 900s (15 min) | Watchdog for legacy CLI spawn mode               |

### RetryBackoff Configuration

| Setting             | Value    |
| ------------------- | -------- |
| `baseDelayMs`       | 1,000ms  |
| `maxDelayMs`        | 60,000ms |
| `maxAttempts`       | 10       |
| `backoffMultiplier` | 1.3      |
| `jitterFactor`      | 0.3      |

After 10 failed attempts, backoff resets and retries indefinitely (except 401/403 which are dropped permanently).

---

## Root Causes

### 1. OpenAI API Stream Disconnects (Upstream, Cannot Fix)

The error `"stream disconnected before completion: stream closed before response.completed"` is the #1 reported issue in the Codex ecosystem.

**Symptoms**:

- Task works for ~60 seconds, then stream terminates
- 300K-2.52M tokens consumed with no complete response
- Affects all platforms, all CLI versions
- gpt-5.2-codex has 30-50% failure rate on multi-turn tool use (iteration 2+)

**Causes**:

- Newer models (5.2+) take longer between token batches, exceeding HTTP timeout values
- Context window overflow (32K/128K limits)
- High reasoning effort (`xhigh`) creates minutes of silence without SSE events
- `UND_ERR_BODY_TIMEOUT` in Node.js `undici` HTTP client — kills connection when no data arrives for body timeout period

**OpenAI's 30-second keepalive** was only deployed in late January 2026 and had a multi-week rollout. Before that, any reasoning pause >30s could trigger proxy/LB idle disconnects.

**Relevant issues**: [#8865](https://github.com/openai/codex/issues/8865), [#9727](https://github.com/openai/codex/issues/9727), [#11735](https://github.com/openai/codex/issues/11735), [#5130](https://github.com/openai/codex/issues/5130)

### 2. sandbox-agent ACP Proxy Timeout (Fixed)

The default `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS` is 120s. When `session/prompt` takes longer (which is routine for coding tasks), sandbox-agent returns HTTP 504. Our daemon treats this as non-fatal for the `session/prompt` POST specifically, but it disrupts the ACP session state.

**Fix**: Bumped to 600s in both `daemon.ts` and `setup.ts` (commit `6679b90`).

### 3. Shell Command Timeouts Within Codex (Upstream, Cannot Fix)

Codex's internal sandbox imposes ~10s default timeout on shell commands. There is **no user-configurable override** — the model picks `timeout_ms` per tool call. `npm install`, `pytest`, and similar commands routinely exceed this.

**Workaround**: Tell Codex in AGENTS.md to use longer timeouts:

```
IMPORTANT: YOU MUST USE TIMEOUT_MS = 600000 FOR ALL SHELL COMMANDS
```

This works ~90% of the time (the model sometimes ignores it).

**Relevant issues**: [#3557](https://github.com/openai/codex/issues/3557), [#7353](https://github.com/openai/codex/issues/7353), [#4775](https://github.com/openai/codex/issues/4775)

### 4. Orphaned Child Processes (Upstream, Cannot Fix)

When Codex's `bash -lc` wrapper times out, only the wrapper PID is killed, not child processes. No `setsid()`/process group management. Orphaned children keep stdout/stderr pipes open, blocking reader tasks indefinitely.

**Relevant issue**: [#4337](https://github.com/openai/codex/issues/4337)

### 5. Context Compaction Stalls (Upstream, Cannot Fix)

Long-running sessions with context compaction enabled can become unresponsive for 1.5+ hours after large build/test output. No error surfaced — the session just hangs.

**Relevant issue**: [#8402](https://github.com/openai/codex/issues/8402)

### 6. Session Resume Corruption with gpt-5.3-codex (Upstream)

ACP `session/resume` fails with `"no rollout found for thread id"`, causing restart loops. The integration enters an infinite retry cycle.

**Relevant issue**: [#11693](https://github.com/openai/codex/issues/11693)

---

## What We've Fixed So Far

### Commit `50d5604` — ACP Error Handling & Retry Resilience

1. **SSE settle delay** — 300ms `abortableSleep` after sandbox-agent restart before connecting SSE. Prevents the 6x "ACP SSE 404" spam from race condition where daemon polls before ACP endpoints register.

2. **SSE 404 suppression** — First 3 failures after restart logged as `debug` instead of `warn`. The `justRestarted` flag resets on first successful SSE connection.

3. **Non-retryable auth errors** — `isNonRetryableAuthError()` detects 401/403 responses and drops messages permanently instead of retrying forever. Resets the `RetryBackoff` and clears the buffer for that thread.

### Commit `6679b90` — ACP Proxy & Codex Timeouts

1. **`SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=600000`** — Set in both `daemon.ts` (runtime env propagation) and `setup.ts` (initial startup). Bumps sandbox-agent's proxy timeout from 120s to 10 min.

2. **Codex config.toml in Dockerfile** — Added `stream_idle_timeout_ms=600000`, `request_max_retries=10`, `stream_max_retries=20`. **However, this may be at the wrong TOML nesting level (see below).**

### Commit `300a622` — Codex Version Bump

Bumped `@openai/codex` from 0.104.0 to 0.107.0 in the sandbox image.

---

## Known Issues We Cannot Fix

| Issue                                            | Root Cause                   | Status                                                              |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------- |
| Stream disconnects on gpt-5.2/5.3                | OpenAI API behavior          | Upstream, no ETA                                                    |
| `request_max_retries` locked for openai provider | By design per OpenAI         | Won't fix ([#3026](https://github.com/openai/codex/issues/3026))    |
| No user-configurable shell timeout               | Missing feature in Codex CLI | Open request ([#4775](https://github.com/openai/codex/issues/4775)) |
| Orphaned child processes                         | No process group management  | Open ([#4337](https://github.com/openai/codex/issues/4337))         |
| Context compaction stalls                        | Codex internal issue         | Open ([#8402](https://github.com/openai/codex/issues/8402))         |
| WebSocket reconnecting loop (3+ sessions)        | Codex CLI networking         | Open ([#5575](https://github.com/openai/codex/issues/5575))         |
| `codex exec --full-auto` hangs                   | Sandbox process group bug    | Open ([#7852](https://github.com/openai/codex/issues/7852))         |

---

## Config.toml Nesting Bug

### The Problem

Our Dockerfile writes:

```toml
stream_idle_timeout_ms = 600000
request_max_retries = 10
stream_max_retries = 20
```

But codex_core expects these under a `[model_providers.<id>]` section:

```toml
[model_providers.openai]
stream_idle_timeout_ms = 600000
stream_max_retries = 20
# request_max_retries = 10  # Won't work for built-in openai provider anyway
```

The top-level placement is **likely silently ignored** by codex_core's TOML parser, meaning the actual effective values are the much lower defaults:

- `stream_idle_timeout_ms` = 300,000ms (5 min) — not our intended 10 min
- `stream_max_retries` = 5 — not our intended 20
- `request_max_retries` = 4 — our override wouldn't work regardless

### The Fix

Change the Dockerfile config to use proper TOML nesting. Note that `request_max_retries` is pointless for the built-in openai provider:

```toml
[model_providers.openai]
stream_idle_timeout_ms = 600000
stream_max_retries = 20
```

### Additional Concern

Our daemon also writes `.codex/config.toml` at runtime during `setupSandboxEveryTime()`. We need to verify that this runtime write doesn't overwrite the Dockerfile config with different/incorrect settings.

---

## Dead Subprocess Caching

### The Problem

sandbox-agent's `AcpProxyRuntime` caches agent instances in a `HashMap`. When codex-acp crashes or exits:

1. The exit watcher broadcasts an `_adapter/agent_exited` notification
2. Pending requests are **NOT proactively failed** — they time out via `tokio::time::timeout`
3. The dead instance **stays cached** in the HashMap
4. `get_or_create_instance()` returns the cached dead instance for subsequent requests
5. New requests fail with `Write` errors (broken stdin pipe → HTTP 502) or `Timeout` (no response → HTTP 504)
6. **No automatic cleanup or respawn** occurs

### Impact

If codex-acp crashes during a task (e.g., due to an OpenAI API error), all subsequent requests to the same agent ID fail until sandbox-agent is restarted entirely.

### Our Current Mitigation

Our daemon restarts sandbox-agent on every new task run (`ensureSandboxAgentHasToken()` kills and restarts the process). This happens because the daemon token changes each run, requiring a restart anyway. This inadvertently clears the dead subprocess cache.

However, if codex-acp crashes **mid-task**, the cached dead instance causes the remainder of that task to fail without recovery.

---

## Error Surface Area

### User-Visible Error Messages

| Error                                                       | Source                          | When                                        |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| `"Codex reported an error."`                                | codex.ts / acp-codex-adapter.ts | Codex-level error (API key, internal error) |
| `"Codex error: no output for Ns; process killed"`           | daemon.ts idle watchdog         | 15 min silence in legacy mode               |
| `"ACP SSE circuit breaker tripped"`                         | daemon.ts                       | 10 consecutive SSE connection failures      |
| `"ACP completion timeout — no SSE activity for 10 minutes"` | daemon.ts                       | 10 min of SSE silence                       |
| `"ACP transport command failed"`                            | daemon.ts catch-all             | Unhandled ACP error                         |
| `"Delegated Codex sub-agent task failed"`                   | codex.ts                        | Multi-agent sub-task failure                |
| `"You've hit your usage limit."`                            | Codex CLI                       | OpenAI rate limit                           |

### Non-Fatal (Logged Only)

| Warning                                                | Source    | Frequency                                |
| ------------------------------------------------------ | --------- | ---------------------------------------- |
| `"ACP SSE not yet available after restart (expected)"` | daemon.ts | Every task start (1-3x)                  |
| `"ACP session/prompt POST failed (non-fatal)"`         | daemon.ts | When proxy times out the long-lived POST |
| `"ACP SSE loop error"`                                 | daemon.ts | SSE connection drop (retried)            |
| `"ACP messages dropped: no active process"`            | daemon.ts | Race condition after task end            |
| `"Ignoring non-fatal Codex warning"`                   | codex.ts  | Codex CLI bug logs warnings as errors    |

### The 504 Path (Most Common Failure)

```
1. Daemon sends POST /v1/acp/{server} with session/prompt
2. sandbox-agent forwards to codex-acp via stdin
3. codex-acp calls OpenAI Responses API (SSE stream)
4. OpenAI takes >120s (now >600s with our fix) to respond
5. sandbox-agent's tokio::time::timeout fires
6. sandbox-agent returns HTTP 504 to daemon
7. Daemon logs: "ACP session/prompt POST failed (non-fatal)"
8. But codex-acp's pending request is abandoned (not killed)
9. SSE events may or may not continue arriving
10. If no more events: 10-min inactivity timeout fires
11. User sees: "ACP completion timeout — no SSE activity for 10 minutes"
```

---

## Competitor Approaches

### Zed IDE

- Uses `@zed-industries/codex-acp` (same adapter)
- 30s init timeout, configurable `context_server_timeout` (default 60s, max 10 min)
- No session resume, no checkpointing
- `dev: open acp logs` command for debugging

### Cursor

- Does **not** use ACP at all
- Uses the Codex IDE Extension (direct integration)
- No ACP proxy layer = no proxy timeout issues

### acpx (Headless ACP Client)

- `--timeout` flag for operation-level timeout
- `--ttl` for session keepalive (default 5 min)
- **Dead session recovery**: Detects dead PIDs, attempts `session/load`, falls back to `session/new`
- Graceful cancellation via ACP `session/cancel` before force-kill

### Community Best Practices

1. Limit to <3 concurrent Codex sessions (3+ causes daily hangs)
2. Use API key auth (`CODEX_API_KEY`), not ChatGPT auth (more WebSocket edge cases)
3. Set `stream_max_retries = 10` in config.toml (helps CLI reconnect after 7-8 retries)
4. Always wrap with external timeout mechanism
5. Kill process groups, not just parent PID
6. Disable unnecessary MCP servers (each adds a timeout point)

---

## Recommended Next Steps

### Immediate (Config Fix)

1. **Fix config.toml nesting** — Move settings under `[model_providers.openai]`:

   ```toml
   [model_providers.openai]
   stream_idle_timeout_ms = 600000
   stream_max_retries = 20
   ```

   Drop `request_max_retries` since it can't be overridden for the built-in provider.

2. **Verify runtime config write** — Check `setupSandboxEveryTime()` in setup.ts to ensure it doesn't overwrite the Dockerfile config.

3. **Add AGENTS.md timeout instruction** — Tell Codex to use long timeouts on shell commands:
   ```
   IMPORTANT: Always use timeout_ms = 600000 for all shell commands.
   ```

### Short-Term (Resilience)

4. **Dead subprocess recovery** — When our daemon detects a 502/504 from sandbox-agent mid-task, restart sandbox-agent and retry the session. Similar to acpx's dead session recovery pattern.

5. **Graceful cancellation** — Send ACP `session/cancel` before killing sandbox-agent on task stop, instead of just `pkill`.

6. **Per-task sandbox-agent health check** — Before sending `session/prompt`, verify the agent subprocess is still alive (e.g., a lightweight `GET /v1/health` or status check).

### Medium-Term (Architectural)

7. **Evaluate legacy transport for Codex** — The `codex exec --json` path avoids the entire sandbox-agent/ACP proxy layer. It has its own issues (orphaned processes, no session resume) but eliminates 2 timeout layers.

8. **Background mode investigation** — OpenAI's `background: true` on the Responses API enables polling + sequence-number-based stream resumption. If codex_core adds support, this would be the most robust solution.

9. **Monitor Codex CLI releases** — Watch for fixes to [#4337](https://github.com/openai/codex/issues/4337) (orphaned processes), [#4775](https://github.com/openai/codex/issues/4775) (configurable shell timeout), and [#8865](https://github.com/openai/codex/issues/8865) (stream disconnects).

---

## Appendix: Full Message Flow Timeline

### Happy Path

```
T=0ms        Unix socket "claude" message received
T=100ms      runCommand() starts
             - Kill previous process, create new state
             - Start heartbeat (5 min interval)

T=100ms      ensureSandboxAgentHasToken():
             - Set DAEMON_TOKEN + SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=600000
             - pkill existing sandbox-agent
T=600ms      - Start new sandbox-agent (inherits env)
T=600-10600  Poll health (up to 20 * 500ms)

T~1100ms     SSE loop starts (300ms settle delay)
             - GET /v1/acp/{serverId} → SSE stream connected

T~1200ms     POST initialize (120s timeout)
T~1300ms     POST session/new (120s timeout) → sessionId
T~1400ms     POST session/prompt (NO timeout, fire-and-forget)

T~1400ms+    SSE events flow:
             - thread.started → system/init
             - reasoning → assistant/thinking
             - command_execution → Bash tool_use / tool_result
             - file_change → FileChange tool_use / tool_result
             Messages buffer, flush every 1000ms

T+5min       First heartbeat POST (empty messages)
T+10min      Second heartbeat POST

T+Nmin       result event from SSE
             - sawTerminalEventFromStream = true
             - sseTerminalPromise resolves

T+Nmin+300ms Wait for quiescence
T+Nmin+500ms Close SSE, DELETE /v1/acp/{serverId}
             Final flushMessageBuffer()
```

### Failure: Stream Disconnect (Most Common)

```
T+60s        OpenAI stream terminates without response.completed
             codex_core retries (up to 5x default, should be 20x with config fix)

             If retries exhausted:
               codex-acp emits error event → ACP session/update
               daemon receives via SSE → "Codex reported an error."

             If retries succeed:
               stream resumes, task continues normally

             If codex-acp crashes:
               sandbox-agent detects exit, broadcasts _adapter/agent_exited
               SSE may stop → daemon's 10-min inactivity timeout
               → "ACP completion timeout — no SSE activity for 10 minutes"
```

### Failure: ACP Proxy Timeout

```
T+600s       sandbox-agent's tokio::time::timeout fires for session/prompt
             Returns HTTP 504 to daemon
             Daemon logs: "ACP session/prompt POST failed (non-fatal)"

             codex-acp is NOT killed — subprocess continues running
             If codex-acp eventually completes:
               SSE events arrive → task succeeds despite 504
             If codex-acp hangs:
               10-min SSE inactivity timeout
               → "ACP completion timeout — no SSE activity for 10 minutes"
```

### Failure: SSE Circuit Breaker

```
             SSE connection fails → backoff 300ms, 600ms, 1200ms...
             After 10 consecutive failures:
               circuitBreakerTripped = true
               sseTerminalPromise resolves

             Polling fallback: GET /v1/acp/{serverId}/status (5 attempts)
             If status.completed === true → synthetic success
             Otherwise → "ACP SSE circuit breaker tripped"
```

---

## References

### OpenAI Codex Issues

- [#8865](https://github.com/openai/codex/issues/8865) — Frequent stream disconnection (gpt-5.2+ models take longer between token batches)
- [#3557](https://github.com/openai/codex/issues/3557) — Shell command timeouts in sandbox (10s default, no user config)
- [#4337](https://github.com/openai/codex/issues/4337) — Orphaned child processes (no setsid/process group kill)
- [#4775](https://github.com/openai/codex/issues/4775) — No default timeout for shell commands (open feature request)
- [#3026](https://github.com/openai/codex/issues/3026) — request_max_retries not honored for built-in openai provider
- [#8402](https://github.com/openai/codex/issues/8402) — Context compaction stalls after large outputs
- [#11693](https://github.com/openai/codex/issues/11693) — ACP session resume broken with gpt-5.3-codex
- [#5575](https://github.com/openai/codex/issues/5575) — Constant hangs with 3+ concurrent sessions
- [#7852](https://github.com/openai/codex/issues/7852) — codex exec --full-auto hangs (orphaned processes)
- [#5948](https://github.com/openai/codex/issues/5948) — Unified exec has no timeout for long-running commands
- [#7353](https://github.com/openai/codex/issues/7353) — Simple commands timeout (pyenv init hangs)
- [#11682](https://github.com/openai/codex/issues/11682) — Stream disconnect regression in v0.100.0+

### OpenAI API

- [Responses API Reference](https://platform.openai.com/docs/api-reference/responses)
- [Streaming Guide](https://developers.openai.com/api/docs/guides/streaming-responses/)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive/)

### Sandbox Agent / ACP

- [rivet-dev/sandbox-agent](https://github.com/rivet-dev/sandbox-agent) — Rust source
- [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) — ACP adapter for Codex
- [Agent Client Protocol spec](https://github.com/agentclientprotocol/agent-client-protocol)
- [openclaw/acpx](https://github.com/openclaw/acpx) — Headless ACP session client

### Leo Commits

- `300a622` — Bump @openai/codex from 0.104.0 to 0.107.0
- `50d5604` — Improve daemon ACP error handling and retry resilience
- `6679b90` — Increase ACP proxy and Codex timeouts to 10 minutes
