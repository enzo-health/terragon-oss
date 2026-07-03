# Plan 001: Cron routes reject unauthenticated requests on every non-development host

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e1cb4079..HEAD -- apps/www/src/app/api/internal/cron/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e1cb4079`, 2026-07-01

## Why this matters

Five internal cron routes only check their bearer token when `NODE_ENV === "production"`. On any internet-reachable non-production deployment — a Vercel preview or staging host, which commonly shares the production database — these routes run with no authentication at all. An attacker who finds the URL can requeue tasks, force-complete active runs, run automations, and drive per-user queue fan-out. The sibling route `scheduled-tasks/route.ts` already does this correctly (it rejects whenever a secret exists, bypassing only in local dev). This plan makes all cron routes fail closed the same way, via one shared helper so the pattern can't drift again.

## Current state

The vulnerable routes all repeat this gate (example from `queued-tasks/route.ts:66-76`):

```ts
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ... work runs here unauthenticated when NODE_ENV !== "production"
}
```

The **correct** existing pattern is in `scheduled-tasks/route.ts:51-59`:

```ts
const authHeader = request.headers.get("authorization");
if (!env.CRON_SECRET || authHeader !== `Bearer ${env.CRON_SECRET}`) {
  // In development without CRON_SECRET, allow access for local testing
  if (process.env.NODE_ENV !== "development" || env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
}
```

Files in scope, each has the vulnerable gate at the top of its `GET` handler:

- `apps/www/src/app/api/internal/cron/queued-tasks/route.ts:66-76`
- `apps/www/src/app/api/internal/cron/stalled-tasks/route.ts` — `GET` handler, same gate
- `apps/www/src/app/api/internal/cron/refresh-snapshots/route.ts:9-15`
- `apps/www/src/app/api/internal/cron/run-deadline-sweep/route.ts` — `GET` handler, same gate
- `apps/www/src/app/api/internal/cron/automations/route.ts:9-15`
- `apps/www/src/app/api/internal/cron/scheduled-tasks/route.ts:51-59` — already correct; migrate to the shared helper for consistency

All import `env` from `@terragon/env/apps-www` and read the bearer via `request.headers.get("authorization")`.

Convention note: these routes use plain `new Response("Unauthorized", { status: 401 })` and `NextRequest`. Match that — do not introduce a new response helper style.

## Commands you will need

| Purpose   | Command                                           | Expected on success |
| --------- | ------------------------------------------------- | ------------------- |
| Typecheck | `pnpm tsc-check`                                  | exit 0, no errors   |
| Test      | `pnpm -C apps/www test src/app/api/internal/cron` | all pass            |

Note: `pnpm -C apps/www test ...` requires packages to be built first if this is a fresh clone: `pnpm -r --filter "./packages/*" build`. `pnpm tsc-check` is the reliable whole-repo gate.

## Scope

**In scope** (the only files you should modify):

- `apps/www/src/app/api/internal/cron/_shared/assert-cron-authorized.ts` (create)
- `apps/www/src/app/api/internal/cron/_shared/assert-cron-authorized.test.ts` (create)
- The six `route.ts` files listed in "Current state"

**Out of scope** (do NOT touch):

- The cron _work_ functions (`processOtherRateLimitedQueues`, `runScheduledTasksCron`, etc.) — auth is the only change.
- `vercel.json` cron schedules — unchanged.
- Any other route under `apps/www/src/app/api/` — only the six cron routes.

## Git workflow

- Branch: `advisor/001-enforce-cron-auth`
- Commit message style (conventional commits, matching `git log`): `fix(cron): fail closed on missing auth outside development`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the shared guard helper

Create `apps/www/src/app/api/internal/cron/_shared/assert-cron-authorized.ts`:

```ts
import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";

/**
 * Returns a 401 Response when the request is not authorized, or null when it
 * may proceed. Fails closed whenever CRON_SECRET is set; the only unauthenticated
 * path is local development with no secret configured.
 */
export function assertCronAuthorized(request: NextRequest): Response | null {
  const authHeader = request.headers.get("authorization");
  const authorized =
    !!env.CRON_SECRET && authHeader === `Bearer ${env.CRON_SECRET}`;
  if (authorized) return null;

  const isLocalDevWithoutSecret =
    process.env.NODE_ENV === "development" && !env.CRON_SECRET;
  if (isLocalDevWithoutSecret) return null;

  return new Response("Unauthorized", { status: 401 });
}
```

**Verify**: `pnpm tsc-check` → exit 0.

### Step 2: Use the helper in all six routes

In each route's `GET` handler, replace the inline auth block with:

```ts
const unauthorized = assertCronAuthorized(request);
if (unauthorized) return unauthorized;
```

Add the import: `import { assertCronAuthorized } from "../_shared/assert-cron-authorized";` (adjust the relative depth — each route is one directory below `cron/`, so `../_shared/...` is correct). Remove the now-unused inline `authHeader` variable in each file. For `scheduled-tasks/route.ts`, replace its (correct but bespoke) block with the same two lines.

**Verify**: `pnpm tsc-check` → exit 0, and `grep -rn 'NODE_ENV === "production"' apps/www/src/app/api/internal/cron/` → **no matches** (all production-only gates removed).

### Step 3: Write the helper unit test

Create `apps/www/src/app/api/internal/cron/_shared/assert-cron-authorized.test.ts` — see Test plan for cases. Model it on any existing route test's use of `vitest` and a stubbed `env` (see `apps/www/src/app/api/internal/cron/scheduled-tasks/route.test.ts` for how `env` is handled in this area).

**Verify**: `pnpm -C apps/www test src/app/api/internal/cron/_shared` → all pass.

## Test plan

New test file `assert-cron-authorized.test.ts` covering:

- Secret set + matching `Authorization: Bearer <secret>` → returns `null` (authorized).
- Secret set + wrong/missing header → returns a `Response` with status 401 (this is the regression case: previously allowed through outside production).
- No secret + `NODE_ENV="development"` → returns `null` (local dev bypass preserved).
- No secret + `NODE_ENV="production"` → returns 401 (fail closed).

Stub `env.CRON_SECRET` and `process.env.NODE_ENV` per case. Model structure after `scheduled-tasks/route.test.ts`.

Verification: `pnpm -C apps/www test src/app/api/internal/cron` → all pass including the 4 new cases.

## Done criteria

- [ ] `pnpm tsc-check` exits 0
- [ ] `grep -rn 'NODE_ENV === "production"' apps/www/src/app/api/internal/cron/` returns no matches
- [ ] `grep -rln "assertCronAuthorized" apps/www/src/app/api/internal/cron/` lists all six route files plus the helper and its test
- [ ] `pnpm -C apps/www test src/app/api/internal/cron` passes, new helper tests included
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- A cron route's `GET` handler does not match the excerpted gate (it already uses a different auth mechanism, or the file moved).
- `env.CRON_SECRET` is not exported from `@terragon/env/apps-www` (the type-check will fail on the helper) — report rather than guessing the env accessor.
- Any cron route reads auth from something other than the `Authorization` header.

## Maintenance notes

- Any new cron route added under `internal/cron/` must call `assertCronAuthorized` as its first line; consider adding a lint/test that asserts this if more routes appear.
- A reviewer should confirm no route left a stale `authHeader` variable and that the relative import path resolves from each route's depth.
- Deferred: constant-time comparison of the bearer token is a separate hardening item (see finding SECURITY-07 / plan not yet written) — not in this plan.
