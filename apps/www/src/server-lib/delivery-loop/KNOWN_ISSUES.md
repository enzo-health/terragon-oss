# Delivery Loop — Known Issues

Last updated: 2026-03-18

## Summary

| Issue                     | Severity | Status              | Blocking?                       |
| ------------------------- | -------- | ------------------- | ------------------------------- |
| ACP "Internal error"      | High     | Partially mitigated | No (infra retry absorbs)        |
| Turbopack stale cache     | Medium   | Resolved            | No (clear cache + restart)      |
| Dispatch intent duplicate | Low      | Known               | No (caught by try/catch)        |
| CLI URL overwrite         | Low      | Workaround          | No (rebuild after restart)      |
| OpenAI API key            | Low      | Known               | No (fallback works)             |
| R2 SSL failure            | Low      | Known               | No (optional telemetry)         |
| Automations GitHub token  | Low      | Pre-existing        | No (unrelated to delivery loop) |

---

## Issue 1: ACP "Internal error" Startup Race Condition

**Status:** Partially mitigated, not fully resolved

### Problem

The `sandbox-agent` binary inside Docker/E2B containers takes ~15s after health check passes to register ACP (Agent Communication Protocol) endpoints. During this window, the Claude Agent SDK gets HTTP 404s which surface as `"Internal error"` with `errorCategory: "daemon_custom_error"`.

### Evidence from E2E Testing

- First E2E task: 5 consecutive ACP failures -> exhausted 6-attempt fix budget -> `awaiting_manual_fix` (BEFORE our fixes)
- Second E2E task: `infra_retry_count=1`, completed successfully
- Third E2E task: `infra_retry_count=5` and still running — ACP failures are frequent

### What we've done so far

1. **Commit `d6b5152`**: Raised SSE circuit breaker from 10->20 (was tripping before 15-failure grace window expired), added retry loop to `session/new` (10 attempts, 1.5s backoff), increased SSE settle delay from 300ms->2s
2. **Commit `c2f4947`**: Separated infrastructure failures from agent failures in delivery loop. `infraRetryCount` tracks ACP failures separately (max 10), doesn't burn `fixAttemptCount` budget. Detection: `isInfrastructureFailure()` checks `kind === "runtime_crash" && message === "Internal error"`

### Root cause analysis

- `sandbox-agent` is closed-source Anthropic binary — we can't modify its startup
- The daemon ACP code is in `packages/daemon/src/daemon.ts`
- Previous fix `144294d` added retry to `initialize` (10 attempts, 1.5s backoff)
- But `session/new` had NO retry — fixed in `d6b5152`
- SSE connections start with settle delay, but failures still accumulate

### Error signature

```json
{ "kind": "runtime_crash", "message": "Internal error", "exitCode": null }
```

### Files involved

- `packages/daemon/src/daemon.ts` — ACP init, SSE, session/new
- `apps/www/src/server-lib/delivery-loop/coordinator/reduce-signals.ts` — infra failure detection
- `packages/shared/src/delivery-loop/domain/workflow.ts` — `infraRetryCount` field
- `packages/shared/src/db/schema.ts` — `infra_retry_count` column

---

## Issue 2: Turbopack Stale Cache on tick.ts

**Status:** Resolved (requires cache clear on dev server restart)

### Problem

After modifying `tick.ts` (adding the `do/while` loop for level-triggered gate bypass), Turbopack cached the old version and failed to recompile. Error: `Expected 'while', got 'type'` at line 759 — but the file is only 593 lines. This caused the `GET /api/internal/cron/scheduled-tasks` route to return 500.

### Impact

- Cron couldn't process coordinator ticks
- Delivery loop still worked via inline dispatch (daemon-event route compiled independently)
- Gate bypass via cron catch-up was broken until cache cleared

### Resolution

```bash
trash apps/www/.next/dev   # or rm -rf
# Restart pnpm dev
```

### Root cause

Turbopack (Next.js 16.1.6) cached a longer version of `tick.ts` before the level-triggered bypass refactor shortened it. The SWC parser tried to parse the cached version, which had `type WorkflowRow` at line 759 immediately after a `do { }` block, and expected `while` keyword instead.

### Prevention

After significant file modifications, clear `apps/www/.next/dev` if Turbopack shows mysterious compile errors with line numbers beyond the file's actual length.

---

## Issue 3: `delivery_loop_dispatch_intent_run_id_unique` Constraint Violation

**Status:** Known, non-blocking

### Problem

The inline dispatch (Fix 1) in `apps/www/src/app/api/daemon-event/route.ts` (~line 1010) calls `runDispatchWork()` which internally calls `createDispatchIntent()`. When the cron ALSO processes the same work item, both try to create a dispatch intent with the same `run_id`, causing a unique constraint violation:

```
error: duplicate key value violates unique constraint "delivery_loop_dispatch_intent_run_id_unique"
Key (run_id)=(32b43888-18a5-4987-90f1-fd31292b5ac1) already exists.
```

### Impact

Non-fatal — the error is caught by the try/catch in the daemon-event route's `waitUntil()` block. The cron acts as safety net, so the duplicate is harmless. But it's noisy in logs.

### Potential fix

Add `ON CONFLICT DO NOTHING` to `createDispatchIntent` in `packages/shared/src/delivery-loop/store/dispatch-intent-store.ts:75`, or check if the intent already exists before creating.

### Files involved

- `apps/www/src/app/api/daemon-event/route.ts` — inline dispatch
- `packages/shared/src/delivery-loop/store/dispatch-intent-store.ts` — intent creation
- `apps/www/src/server-lib/delivery-loop/workers/run-dispatch-work.ts` — dispatch worker

---

## Issue 4: CLI Build URL Overwritten by `pnpm dev`

**Status:** Known, workaround documented

### Problem

The CLI binary (`apps/cli`) uses `tsup` which bakes `TERRAGON_WEB_URL` at build time. When `pnpm dev` starts, turbo runs the CLI's `dev` script with `tsup --watch`, which rebuilds the CLI WITHOUT the env var — overwriting our manual `TERRAGON_WEB_URL=https://terragon.ngrok.dev pnpm build`.

### Impact

After restarting `pnpm dev`, the CLI reverts to pointing at `https://www.terragonlabs.com` (production). All CLI commands hit prod instead of dev.

### Workaround

After every `pnpm dev` restart, rebuild the CLI manually:

```bash
cd apps/cli && TERRAGON_WEB_URL=https://terragon.ngrok.dev pnpm build && npm link
```

### Potential fix

- Add `TERRAGON_WEB_URL` to `.env.development.local` so turbo's watch build picks it up
- Or modify `apps/cli/tsup.config.ts` to read from a dev env file

---

## Issue 5: OpenAI API Key Invalid in Dev

**Status:** Known, non-blocking

### Problem

The dev environment has an invalid OpenAI API key. This causes commit message generation to fail:

```
"message": "Incorrect API key provided: ***. You can find your API key at https://platform.openai.com/account/api-keys."
```

### Impact

- Commit messages fall back to a default/template instead of AI-generated
- Does not block the delivery loop — git operations still proceed
- Shows up as noisy errors in server logs

### Fix

Set a valid `OPENAI_API_KEY` in `apps/www/.env.development.local`

---

## Issue 6: R2 Upload SSL Handshake Failure

**Status:** Known, non-blocking

### Problem

Claude session uploads to Cloudflare R2 fail with SSL handshake error:

```
Error uploading Claude session to R2 [TypeError: fetch failed] {
  [cause]: [Error: ssl/tls alert handshake failure]
}
```

### Impact

- Claude sessions aren't persisted to R2 in dev
- Does not affect delivery loop or task execution
- Historical session data not available for dev debugging

### Fix

Configure R2 credentials properly in dev environment, or ignore (it's optional telemetry).

---

## Issue 7: Automations Cron GitHub Token Error

**Status:** Pre-existing, not related to our changes

### Problem

The automations cron at `apps/www/src/app/api/internal/cron/automations/route.ts` fails with:

```
SyntaxError: Input string must contain hex characters in even length
  at Uint8Array.fromHex (<anonymous>)
  at async getGitHubUserAccessToken (src/lib/github.ts:332:20)
```

Then: `No github access token found`

### Impact

- Automated PR-triggered tasks don't run in dev
- Not related to delivery loop changes

### Root cause

The GitHub OAuth access token in the DB may have an encryption/encoding issue — `Uint8Array.fromHex` suggests the token is encrypted but the encryption key or format is wrong in dev.
