# Plan 002: Slack webhook rejects requests in production when the signing secret is unset

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e1cb4079..HEAD -- apps/www/src/app/api/webhooks/slack/`
> On any change to the file below, compare the "Current state" excerpt against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e1cb4079`, 2026-07-01

## Why this matters

The Slack webhook skips signature verification entirely when `SLACK_SIGNING_SECRET` is empty. If Slack is ever enabled in production without the secret set, an unauthenticated attacker can POST forged `app_mention` / `block_actions` events that create tasks and drive agent runs — real compute and repo access, triggered by anyone. The signature check itself is correct (timing-safe, with a 5-minute replay window); only the fail-_open_ default is wrong. The Linear webhook in this same codebase already models the fix: it fails closed in production and only bypasses in local dev. This plan brings Slack in line.

## Current state

`apps/www/src/app/api/webhooks/slack/route.ts:38-46` — the gate short-circuits when the secret is falsy:

```ts
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Skip signature verification if no secret is configured (development)
  if (env.SLACK_SIGNING_SECRET && !verifySlackSignature(req, rawBody)) {
    console.error("[slack webhook] Invalid signature");
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }
  // ... payload parsed and dispatched to handleAppMentionEvent
}
```

`verifySlackSignature` (`route.ts:6-34`) already throws if the secret is unset and returns a timing-safe boolean otherwise — it is correct and stays unchanged.

The **reference fix** is the Linear webhook, `apps/www/src/app/api/webhooks/linear/route.ts:27-40`:

```ts
function verifyLinearSignature(req: NextRequest, rawBody: string): boolean {
  if (!env.LINEAR_WEBHOOK_SECRET) {
    // Fail closed in production; allow in development for testing
    if (process.env.VERCEL_ENV) {
      console.error(
        "[linear webhook] LINEAR_WEBHOOK_SECRET is not set in production, rejecting",
      );
      return false;
    }
    console.warn(
      "[linear webhook] LINEAR_WEBHOOK_SECRET is not set, skipping verification (dev only)",
    );
    return true;
  }
  // ... verify
}
```

Note the production signal used in this codebase for webhooks is `process.env.VERCEL_ENV` (truthy on any deployed Vercel env), not `NODE_ENV`. Match Linear exactly.

## Commands you will need

| Purpose   | Command                                            | Expected on success |
| --------- | -------------------------------------------------- | ------------------- |
| Typecheck | `pnpm tsc-check`                                   | exit 0, no errors   |
| Test      | `pnpm -C apps/www test src/app/api/webhooks/slack` | all pass            |

Fresh clone: run `pnpm -r --filter "./packages/*" build` before the test command.

## Scope

**In scope**:

- `apps/www/src/app/api/webhooks/slack/route.ts`
- `apps/www/src/app/api/webhooks/slack/route.test.ts` (create if absent; if a test file already exists, extend it)

**Out of scope**:

- `verifySlackSignature`'s HMAC/replay logic — correct, do not modify.
- `./handlers` (`handleAppMentionEvent`) — the dispatch target is unchanged.
- The Linear webhook — it is the reference, not a target.

## Git workflow

- Branch: `advisor/002-slack-webhook-fail-closed`
- Commit message: `fix(slack): fail closed when signing secret is unset in production`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make the missing-secret case fail closed in production

In `route.ts`, change the gate so a missing secret rejects on any deployed Vercel environment and only bypasses in local dev. Replace the current `if (env.SLACK_SIGNING_SECRET && !verifySlackSignature(...))` block with logic equivalent to:

```ts
if (!env.SLACK_SIGNING_SECRET) {
  if (process.env.VERCEL_ENV) {
    console.error(
      "[slack webhook] SLACK_SIGNING_SECRET is not set in production, rejecting",
    );
    return NextResponse.json(
      { success: false, error: "Signature verification unavailable" },
      { status: 401 },
    );
  }
  console.warn(
    "[slack webhook] SLACK_SIGNING_SECRET is not set, skipping verification (dev only)",
  );
} else if (!verifySlackSignature(req, rawBody)) {
  console.error("[slack webhook] Invalid signature");
  return NextResponse.json(
    { success: false, error: "Invalid signature" },
    { status: 401 },
  );
}
```

This keeps the existing dev bypass, keeps the existing invalid-signature path, and adds the production-without-secret rejection. Do not call `verifySlackSignature` when the secret is unset (it throws by design).

**Verify**: `pnpm tsc-check` → exit 0.

### Step 2: Test the three branches

See Test plan. Verify: `pnpm -C apps/www test src/app/api/webhooks/slack` → all pass.

## Test plan

New/extended `route.test.ts` covering the `POST` handler:

- Secret unset + `VERCEL_ENV` truthy → 401, `handleAppMentionEvent` not called (the regression case).
- Secret unset + `VERCEL_ENV` unset (local dev) → request proceeds (bypass preserved).
- Secret set + invalid signature → 401 (existing behavior still holds).

Stub `env.SLACK_SIGNING_SECRET`, `process.env.VERCEL_ENV`, and mock `./handlers`. If no Slack route test exists, model the file on `apps/www/src/app/api/webhooks/linear/route.test.ts` if present, otherwise on any `route.test.ts` under `apps/www/src/app/api/` that builds a `NextRequest` and asserts on the `Response` status.

Verification: `pnpm -C apps/www test src/app/api/webhooks/slack` → all pass including 3 new cases.

## Done criteria

- [ ] `pnpm tsc-check` exits 0
- [ ] Slack route rejects (401) when `SLACK_SIGNING_SECRET` unset and `VERCEL_ENV` is set — proven by a passing test
- [ ] Local-dev bypass (no secret, no `VERCEL_ENV`) still works — proven by a passing test
- [ ] `pnpm -C apps/www test src/app/api/webhooks/slack` passes
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- The current `POST` gate does not match the excerpt (file drifted).
- `process.env.VERCEL_ENV` is not the production signal used elsewhere in `webhooks/` (grep `webhooks/` — if the convention is different, use the codebase's actual signal and note it).
- `verifySlackSignature` no longer throws on a missing secret (its contract changed) — reassess before relying on it.

## Maintenance notes

- If Slack support is later gated behind a feature flag, the fail-closed check should run before any event handling regardless of the flag.
- A reviewer should confirm the production signal matches Linear's (`VERCEL_ENV`) and that no code path calls `verifySlackSignature` with an unset secret.
