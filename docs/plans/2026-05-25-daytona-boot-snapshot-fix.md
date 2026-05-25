# Fix slow Daytona boots: repair the per-repo snapshot pipeline

**Status:** proposal — for review
**Date:** 2026-05-25
**Author:** investigation off task `2a5a7ec7-2c4a-4f07-86e7-2389a7507222`

## Problem

A Linear-mention task on `enzo-health/bonaparte` took **120s to boot** before the
agent said a word. That is the slowest of all recent Daytona boots and ~4× the
median.

The boot is a strict barrier today:

```
clone repo -> install agent -> run setup script -> booting-done -> dispatch agent
```

The `run setup script` phase (repo `terragon-setup.sh`: dep install / build) is
the dominant cost. It sits on the critical path before `RUN_STARTED`.

### Evidence (prod)

| Boot profile                            | boot time                 |
| --------------------------------------- | ------------------------- |
| `skip_setup = true` (11 recent threads) | 24–46s                    |
| `skip_setup = false` (3 recent threads) | 94.5s, 103.8s, **120.0s** |

Boot window for this task, from `agent_event_log` + `agent_run_context`:

- `19:53:24` prompt persisted (`MESSAGES_SNAPSHOT`)
- _(125s silent boot window — clone + agent install + setup script)_
- `19:55:23` `agent_run_context` created (sandbox ready)
- `19:55:28` `RUN_STARTED`, text streamed normally to `19:59:36`, ran to completion

Single clean run, no infra retries. The thread status briefly read `booting`
mid-flight but advanced normally (`checkpointing`). No stuck-status bug.

## Root cause

The fix already exists and is stronger than parallelizing: **per-repo snapshots**
that bake deps + setup into the Daytona image so the setup script is skipped
entirely (`getReadySnapshot` in `sandbox.ts:730` → `setup.ts:281` skips the
script when a snapshot is resolved). It is simply broken for bonaparte.

bonaparte's environment (`environment.snapshots`) has exactly one entry:

```json
{
  "size": "small",
  "status": "building",
  "snapshotName": "",
  "builtAt": "2026-03-05T03:15:44Z",
  "provider": "daytona"
}
```

Two independent failures:

1. **Size mismatch.** Only `small` was ever attempted; this task needed `large`.
   The lookup keys on size, so it would never match.
2. **Zombie `building`.** That entry has been stuck in `building` with an empty
   `snapshotName` for ~2.5 months. The March build (Vercel `waitUntil`, 5–15 min)
   was killed mid-flight; the `.catch` failure handler never ran, so the entry
   was never flipped to `failed` and never retried.

`getReadySnapshot` only matches `status === "ready"`, so every bonaparte task —
of any size — pays the full ~90s setup, forever, with no signal that anything
is wrong.

### Why snapshots silently stop helping

- Builds are **manual** (`buildEnvironmentSnapshot` is a `userOnlyAction` from
  Settings). Nothing rebuilds automatically.
- Matches require an exact 4-part hash: `setupScriptHash`, `baseDockerfileHash`,
  `environmentVariablesHash`, `mcpConfigHash` — plus size. Any change to the
  setup script, env vars, MCP config, or base image invalidates the match and
  marks snapshots `stale`. Nobody rebuilds them.
- A build killed under `waitUntil` strands the entry in `building` with no
  cleanup.

## Recommendation: fix the snapshot path (Plan A)

Highest leverage, lowest risk. Removes the 90s instead of hiding it. No
agent-behavior change. Likely turns this exact 120s boot into ~25s for every
task after the first on a repo.

### A1 — Reap zombie builds

Treat a `building` entry as `failed` (retryable) when it is older than a timeout
or has an empty `snapshotName`.

- Add a `buildStartedAt` / staleness check. Where: `getReadySnapshot` should keep
  ignoring non-`ready`, but a reaper (cron or on-boot) flips stale `building`
  → `failed` so the UI is honest and the next boot retries.
- Threshold: ~20 min (builds are 5–15 min).

### A2 — Auto-build on cache miss

When a task boots and finds no ready snapshot for its size, kick
`buildRepoSnapshot` in the background (already runs under `waitUntil`). The first
task still pays full setup; every later task on that repo is fast.

- Trigger point: the `snapshot === null` branch in `sandbox.ts:730`.
- Fire-and-forget; must not block or fail the boot.
- Debounce so concurrent boots don't launch duplicate builds (one `building`
  entry acts as the lock — reuse it, given A1 reaps dead ones).

### A3 — Build the size tasks actually use

Only `small` was attempted; bonaparte tasks run `large`. Either build both sizes
or the size the repo's tasks request. A2 handles this naturally if it builds for
the requesting task's size.

### A4 — Harden the build lifecycle

A 5–15 min build under Vercel `waitUntil` is fragile. Options:

- Persist `building` with a timestamp (pairs with A1 so a killed build self-heals).
- Or move snapshot builds off the request path to a dedicated long-running job.

## Plan B — background setup + early dispatch (separate PR, gated)

Hides (not removes) the 90s for cold cache-miss boots. Pursue after A, and only
if cold boots still need to feel fast. **Held as a separate PR:** it rewrites
the boot → dispatch critical path and depends on sandbox-side detached execution
that cannot be verified without a live Daytona sandbox (the integration harness
replays daemon events; it does not boot a sandbox). Shipping it requires a real
boot to validate. Gate the whole thing behind a default-off feature flag
`backgroundSetupScript`.

Confirmed integration points:

### B1 — Run setup detached in the sandbox, write a sentinel

In `runSetupScript` (`setup.ts:770`), when the flag is on, don't run the script
with an awaited `executeSetupScriptCommand`. Instead launch it detached inside
the sandbox and return immediately:

```sh
mkdir -p /root/.terragon
nohup bash -c '
  bash -x /tmp/terragon-setup-custom.sh > /root/.terragon/setup.log 2>&1
  echo $? > /root/.terragon/setup-exit-code
  touch /root/.terragon/setup-complete
' >/dev/null 2>&1 &
```

Tradeoff: backgrounding breaks the `onInstallProgress` streaming chips (they
read awaited stdout). Either poll `/root/.terragon/setup.log` for progress or
accept losing the chips while backgrounded.

### B2 — Don't await setup; return the session

In `runSandboxSetup` (`setup.ts:284–305`), under the flag, `await` only
`daemonInstallAndProbe`; launch B1 without awaiting. Boot reaches `booting-done`
once the daemon is probed.

### B3 — Dispatch the agent early

`startAgentMessage.ts` (~549–594) already dispatches right after
`createSandboxForThread` returns. Once B2 returns early, dispatch happens while
setup runs. No structural change beyond B2.

### B4 — Gate dependent commands (the hard part)

No daemon chokepoint per tool call exists: in `codex-app-server` transport the
agent runs shell directly in the sandbox (daemon `runCommand` handles prompts,
not tool calls). So enforce with a PATH wrapper installed before dispatch — shim
`pnpm`/`npm`/`yarn`/`node` in `/usr/local/bin` to block until the sentinel:

```sh
#!/usr/bin/env bash
while [ ! -f /root/.terragon/setup-complete ]; do sleep 1; done
exec /usr/bin/REAL_TOOL "$@"
```

Plus a soft nudge: inject "deps are still installing; avoid build/test until
notified" into the agent context.

### B5 — Error propagation

If background setup fails after the agent has started, the agent runs against a
half-set-up repo. Surface the non-zero `/root/.terragon/setup-exit-code` as a
chat error / meta event so failures aren't silent.

B only helps tasks whose early work doesn't need deps (this task qualifies; a
`pnpm build`-first task gains nothing). A and B compose: A for the warm steady
state, B for cold cache-miss boots.

## Open questions

1. Where should the reaper run — cron, or inline at boot when reading snapshots?
2. Auto-build on miss for both sizes, or only the requesting size?
3. Is `waitUntil` acceptable for builds, or do we need a dedicated job runner?
4. Do we need B at all, or is "first task slow, rest fast" good enough?

## Status

- **Plan A (A1+A2+A3): implemented and verified.** Reaper + auto-build-on-miss
  for the requesting size, debounced by the `building` lock, wired into the boot
  path. `tsc-check` clean (only the pre-existing unrelated `@pierre/trees`
  missing-dep error remains); 13/13 environments tests pass (5 new for the
  reaper). Branch `fix/daytona-boot-snapshot-and-background-setup`.
  - `packages/shared/src/model/environments.ts` — `isSnapshotBuildStale`,
    `reapStaleBuildingSnapshots`, `SNAPSHOT_BUILD_TIMEOUT_MS` (20 min).
  - `apps/www/src/server-lib/environment-snapshot-build.ts` — shared build core +
    `maybeTriggerSnapshotBuildForBoot`.
  - `apps/www/src/server-actions/environment-snapshot.ts` — Settings action now
    calls the shared core (no duplicated lifecycle logic).
  - `apps/www/src/agent/sandbox.ts` — fire-and-forget trigger in
    `getBootstrapContext` for fresh Daytona boots.
- **Plan B (B1–B5): implemented behind the `backgroundSetupScript` flag
  (default off), unit-tested, NOT yet verified on a live sandbox.** `tsc-check`
  clean; 26/26 sandbox setup tests pass (5 new for the background launch).
  - `packages/shared/src/model/feature-flags-definitions.ts` —
    `backgroundSetupScript` flag (default false).
  - `packages/sandbox/src/types.ts` — `backgroundSetupScript?: boolean` option.
  - `packages/sandbox/src/setup.ts` — `launchSetupScriptInBackground`: detached
    runner + sentinel + exit-code file + PATH-shim barrier for
    pnpm/npm/yarn/node; new branch in `runSandboxSetup`.
  - `apps/www/src/agent/sandbox.ts` — passes the flag through.
  - **Must verify before enabling in prod:** that the agent's shell picks up the
    prepended PATH (the shims live in `<home>/.terragon/bin`, prepended via
    `/etc/profile.d` and `~/.bashrc`). If codex spawns non-login shells that skip
    both, the barrier won't engage. Smoke-test a real Daytona boot with the flag
    on and confirm `pnpm` blocks until the sentinel.
- **Plan A4: not implemented.** Durable build runner is optional follow-up.

## Decisions captured

- Reaper runs inline at boot (no new cron).
- Auto-build builds only the requesting task's size.
- First task on a cold repo still pays full setup; every task after the build
  completes is fast (~25s).
