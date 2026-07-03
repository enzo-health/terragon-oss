# Plan 005: Fix three resource/cost leaks in the Daytona provider

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e1cb4079..HEAD -- packages/sandbox/src/providers/daytona-provider.ts`
> On any change, compare each "Current state" excerpt against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but see plan 017/TESTS-01 if written — provider tests reduce regression risk)
- **Category**: bug
- **Planned at**: commit `e1cb4079`, 2026-07-01

## Why this matters

The Daytona provider leaks billed cloud resources on failure paths and leaks a timer on every blocking command:

1. If one-time setup throws after a sandbox is created, the sandbox is never torn down — a running, billed sandbox nothing reclaims (the caller never got the handle).
2. Every blocking command arms a 5-minute `setTimeout` that is never cleared, so a fast command leaves a live timer for up to 5 minutes (delays process exit, accumulates under load) and the racing log promise is abandoned unhandled.
3. `shutdown()` calls `stop()` then `delete()`; if `stop()` throws (already stopping, transient API error) the `delete()` never runs and the sandbox leaks.

Each is a small, self-contained fix on the same file. Daytona is currently behind a feature flag, so blast radius is limited, but these are real cost/stability leaks.

## Current state

**Leak 1 — setup failure leaks the sandbox** (`daytona-provider.ts:889-896`, inside `getOrCreateSandbox`):

```ts
const sandbox = await createWithRetry(templateId, envs, options.daytonaVolume);
const session = new DaytonaSession(sandbox);
await setupDaytonaOneTime(session); // <- no try/catch; a throw leaks `sandbox`
return session;
```

`DaytonaSession` exposes `async shutdown()` (defined at `daytona-provider.ts:736`) which stops and deletes the underlying sandbox.

**Leak 2 — uncleared timer + abandoned log promise** (`daytona-provider.ts:610-635`, inside the command method):

```ts
if (!options?.blockUntilComplete) {
  return { sessionId, cmdId: commandId }; // commandLogsPromise abandoned unawaited
}
const result = await Promise.race([
  commandLogsPromise,
  new Promise<"timeout">((resolve) =>
    setTimeout(() => {
      resolve("timeout");
    }, options?.timeoutMs || DEFAULT_TIMEOUT_MS),
  ),
]);
if (result === "timeout") {
  throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
}
```

`DEFAULT_TIMEOUT_MS = 5 * 60 * 1000` (`daytona-provider.ts:25`). The `setTimeout` handle is never captured, so it stays armed after the command completes.

**Leak 3 — shutdown skips delete on stop error** (`daytona-provider.ts:736-739`):

```ts
async shutdown(): Promise<void> {
  await this.sandbox.stop();
  await this.sandbox.delete();
}
```

For contrast, E2B's destroy is a single atomic `kill()` (`e2b-provider.ts:165-166`).

## Commands you will need

| Purpose   | Command                                                        | Expected on success |
| --------- | -------------------------------------------------------------- | ------------------- |
| Typecheck | `pnpm tsc-check`                                               | exit 0, no errors   |
| Test      | `pnpm -C packages/sandbox test src/providers/daytona-provider` | all pass            |

Fresh clone: run `pnpm -r --filter "./packages/*" build` before the test command.

## Scope

**In scope**:

- `packages/sandbox/src/providers/daytona-provider.ts`
- `packages/sandbox/src/providers/daytona-provider.test.ts` (extend — it already exists)

**Out of scope**:

- `e2b-provider.ts`, `docker-provider.ts`, `mock-provider.ts` — reference only.
- `createWithRetry`, `setupDaytonaOneTime` internals — unchanged; we only wrap the caller.
- The `ISandboxSession` interface (`packages/sandbox/src/types.ts`) — no signature changes.

## Git workflow

- Branch: `advisor/005-daytona-resource-leaks`
- Commit message: `fix(sandbox): stop leaking Daytona sandboxes and command timers`
  (or one commit per leak if you prefer — all under the same branch)
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Destroy the sandbox if one-time setup fails

Wrap the setup call so a throw tears the sandbox down before re-propagating:

```ts
const session = new DaytonaSession(sandbox);
try {
  await setupDaytonaOneTime(session);
} catch (error) {
  await session.shutdown().catch(() => {});
  throw error;
}
return session;
```

**Verify**: `pnpm tsc-check` → exit 0.

### Step 2: Clear the timeout and handle the abandoned log promise

Capture the timeout id and clear it once the race settles; attach a `.catch` to the log promise on the non-blocking and timeout branches so it can't become an unhandled rejection. Target shape:

```ts
if (!options?.blockUntilComplete) {
  void commandLogsPromise.catch(() => {});
  return { sessionId, cmdId: commandId };
}
let timeoutId: ReturnType<typeof setTimeout> | undefined;
const result = await Promise.race([
  commandLogsPromise,
  new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(
      () => resolve("timeout"),
      options?.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
  }),
]).finally(() => {
  if (timeoutId) clearTimeout(timeoutId);
});
if (result === "timeout") {
  void commandLogsPromise.catch(() => {});
  throw new Error(
    `Command timed out after ${options?.timeoutMs || DEFAULT_TIMEOUT_MS}ms`,
  );
}
```

(Also fixes the pre-existing cosmetic bug where the timeout message printed `0ms` when no explicit `timeoutMs` was passed — now prints the real default.)

**Verify**: `pnpm tsc-check` → exit 0.

### Step 3: Make shutdown always attempt delete

```ts
async shutdown(): Promise<void> {
  try {
    await this.sandbox.stop();
  } catch (error) {
    console.warn("[daytona] stop() failed during shutdown, proceeding to delete", error);
  }
  await this.sandbox.delete();
}
```

**Verify**: `pnpm tsc-check` → exit 0, then `pnpm -C packages/sandbox test src/providers/daytona-provider` → all pass.

## Test plan

Extend `daytona-provider.test.ts` (mirror its existing `vi.mock("@daytonaio/sdk", ...)` setup at `daytona-provider.test.ts:10-27`). Cases:

- **Setup-failure cleanup**: make `setupDaytonaOneTime`'s effect throw (e.g. the mocked sandbox's setup call rejects) → `getOrCreateSandbox` rejects AND the mocked sandbox's `stop`/`delete` (via `shutdown`) were called. Assert on the mock.
- **Timer cleared**: run a blocking command whose log promise resolves before the timeout → command returns normally. Assert no error; if the mock exposes it, assert the fake timer count returns to zero (use `vi.useFakeTimers()` and `vi.getTimerCount()` — after the command settles, `vi.getTimerCount()` should be 0). If fake timers are impractical against the SDK mock, at minimum assert the happy-path return value and note the timer assertion was skipped.
- **Shutdown resilient to stop error**: mock `sandbox.stop()` to reject → `shutdown()` still calls `sandbox.delete()` and does not reject.

Verification: `pnpm -C packages/sandbox test src/providers/daytona-provider` → all pass including new cases.

## Done criteria

- [ ] `pnpm tsc-check` exits 0
- [ ] Test proves setup failure triggers `shutdown()` on the created sandbox
- [ ] Test proves `shutdown()` calls `delete()` even when `stop()` rejects
- [ ] `grep -n "clearTimeout" packages/sandbox/src/providers/daytona-provider.ts` returns a match
- [ ] `pnpm -C packages/sandbox test src/providers/daytona-provider` passes
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Any of the three excerpts does not match the live code (drifted).
- `DaytonaSession.shutdown` is not accessible from `getOrCreateSandbox` (e.g. it was refactored to a free function) — adapt to call the real teardown, or STOP if unclear.
- The `daytonaio/sdk` mock can't be made to reject `stop()` / setup without breaking other tests — report; do not weaken the existing tests to force it.

## Maintenance notes

- If Daytona graduates from behind its feature flag, these leaks become higher-severity — worth confirming the fixes are still present.
- A reviewer should check that `session.shutdown().catch(() => {})` in Step 1 doesn't swallow a _different_ meaningful error path, and that the `.finally(clearTimeout)` runs on both resolve and reject.
- The abandoned-log-promise `.catch(() => {})` is intentional fire-and-forget on non-blocking commands; if log capture on non-blocking commands is later needed, revisit.
