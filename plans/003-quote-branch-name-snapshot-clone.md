# Plan 003: Quote and validate the branch name in the Daytona snapshot git clone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e1cb4079..HEAD -- packages/sandbox/src/snapshot-builder.ts`
> On any change, compare the "Current state" excerpt against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e1cb4079`, 2026-07-01

## Why this matters

`buildRepoSnapshot` interpolates a git branch name straight into a shell `git clone` command that runs during Daytona image builds. Git refs legally permit `` ` ``, `$`, `(`, `)`, `;`, `&`, `|` — so a user who controls a repo Terragon builds snapshots for can name its default branch `` `...` `` or `$(...)` and execute arbitrary commands in the build worker. Worse, the access token is embedded in the `cloneUrl` on the same command line, so an injected command can exfiltrate it. The webhook that reaches this sink is signature-verified, but the branch value inside it is legitimately attacker-influenced. This codebase already has the exact fix used on the parallel clone path (`setup.ts`): `bashQuote` plus `validateBranchName`. This plan applies them here.

## Current state

`packages/sandbox/src/snapshot-builder.ts:98-101` — the vulnerable sink inside `buildRepoSnapshot` (signature at `snapshot-builder.ts:63`, params `repoFullName: string` and `baseBranch: string`):

```ts
const cloneUrl = `https://${githubAccessToken}@github.com/${repoFullName}.git`;
image = image.runCommands(
  `git clone --filter=blob:none --no-recurse-submodules --branch ${baseBranch} ${cloneUrl} /root/repo`,
);
```

`runCommands(...)` becomes a Dockerfile `RUN` executed by `/bin/sh -c`, so shell metacharacters in `baseBranch` are interpreted. `repoFullName` is also interpolated (here and again at `snapshot-builder.ts:128`, `:131`) — it is `owner/repo` and lower-risk, but validate it too.

Source of `baseBranch`: `apps/www/src/app/api/webhooks/github/handle-snapshot-refresh.ts:23` derives it from `payload.ref` → `refreshEnvironmentSnapshotsForRepo` → `buildRepoSnapshot`.

**The existing safe helpers** (reuse these; do not write new ones):

`packages/sandbox/src/utils.ts:24` — `export function bashQuote(str: string): string` (single-quote shell escaping).

`packages/sandbox/src/commands/utils.ts:16-30` — `validateBranchName({ branchName, label? })` throws on dangerous chars (`DANGEROUS_CHARS_REGEX` at `commands/utils.ts:7`).

**The reference-correct call site**, `packages/sandbox/src/setup.ts:632-636`:

```ts
if (options.repoBaseBranchName) {
  cloneCommand += ` --branch ${bashQuote(options.repoBaseBranchName)}`;
}
```

(`setup.ts:15` imports `bashQuote`.)

## Commands you will need

| Purpose   | Command                                              | Expected on success |
| --------- | ---------------------------------------------------- | ------------------- |
| Typecheck | `pnpm tsc-check`                                     | exit 0, no errors   |
| Test      | `pnpm -C packages/sandbox test src/snapshot-builder` | all pass            |

`packages/sandbox` tests run against built deps; if resolution fails on a fresh clone, run `pnpm -r --filter "./packages/*" build` first.

## Scope

**In scope**:

- `packages/sandbox/src/snapshot-builder.ts`
- `packages/sandbox/src/snapshot-builder.test.ts` (create if absent; otherwise extend)

**Out of scope**:

- `bashQuote` and `validateBranchName` — reuse as-is, do not modify.
- `setup.ts` — it is already correct (the reference).
- The webhook handler and `refreshEnvironmentSnapshotsForRepo` — validation belongs at the sink; do not scatter it upstream.
- The `pnpm install` / `git remote set-url` commands lower in the same file that use only `repoFullName` — covered by validating `repoFullName` once (Step 2), no further change.

## Git workflow

- Branch: `advisor/003-quote-snapshot-branch`
- Commit message: `fix(sandbox): validate and quote branch name in snapshot clone`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Validate then quote `baseBranch` at the clone sink

Add the import at the top of `snapshot-builder.ts`:

```ts
import { bashQuote } from "./utils";
import { validateBranchName } from "./commands/utils";
```

(Confirm the relative paths resolve — `snapshot-builder.ts` is at `packages/sandbox/src/`, so `./utils` and `./commands/utils` are correct.)

Immediately before the `image.runCommands(... --branch ...)` call, add:

```ts
validateBranchName({ branchName: baseBranch, label: "snapshot base branch" });
```

Then change the interpolation to quote it:

```ts
`git clone --filter=blob:none --no-recurse-submodules --branch ${bashQuote(baseBranch)} ${cloneUrl} /root/repo`,
```

`validateBranchName` throwing is the desired behavior — a dangerous branch name aborts the build loudly rather than cloning something unexpected.

**Verify**: `pnpm tsc-check` → exit 0.

### Step 2: Validate `repoFullName`

`repoFullName` is `owner/repo`; a slash is legal and `validateBranchName` would reject it, so do NOT run it through `validateBranchName`. Instead add a narrow guard near the top of `buildRepoSnapshot` (right after the params are in scope):

```ts
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoFullName)) {
  throw new Error(`Invalid repoFullName: ${repoFullName}`);
}
```

This rejects any shell metacharacter while allowing the one legitimate slash.

**Verify**: `pnpm tsc-check` → exit 0.

### Step 3: Test injection is neutralized

See Test plan. Verify: `pnpm -C packages/sandbox test src/snapshot-builder` → all pass.

## Test plan

New/extended `snapshot-builder.test.ts`. `buildRepoSnapshot` builds a Daytona `Image`; mock `@daytonaio/sdk` the way `daytona-provider.test.ts:10-27` does (a `MockDaytona` / stub `Image` whose `runCommands` records the command strings). Cases:

- A benign branch (`main`) → the recorded clone command contains `--branch main` (quoted form acceptable) and builds without throwing.
- An injection branch (`` `id` `` or `$(id)` or `a;rm -rf /`) → `buildRepoSnapshot` throws from `validateBranchName`, and no clone command is issued.
- `repoFullName` with a metacharacter (`owner/repo;id`) → throws from the Step 2 guard.

Model mocking/structure on `packages/sandbox/src/providers/daytona-provider.test.ts`.

Verification: `pnpm -C packages/sandbox test src/snapshot-builder` → all pass including new cases.

## Done criteria

- [ ] `pnpm tsc-check` exits 0
- [ ] `grep -n "bashQuote(baseBranch)" packages/sandbox/src/snapshot-builder.ts` returns a match
- [ ] `grep -n "validateBranchName" packages/sandbox/src/snapshot-builder.ts` returns a match
- [ ] A test proves an injection branch name throws before any clone command is issued
- [ ] `pnpm -C packages/sandbox test src/snapshot-builder` passes
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- The clone line in `snapshot-builder.ts` no longer matches the excerpt.
- `bashQuote` or `validateBranchName` cannot be imported from the stated paths (they moved) — find them via `grep -rn "export function bashQuote\|export function validateBranchName" packages/sandbox/src` and use the real path; if not found, STOP.
- Mocking the Daytona `Image` builder proves infeasible in a unit test — report; do not skip the injection test.

## Maintenance notes

- Any future command in `buildRepoSnapshot` that interpolates a user-influenced value must go through `bashQuote` / a validator — the file handles secrets (the token in `cloneUrl`), so treat every `runCommands` string as security-sensitive.
- A reviewer should confirm the token in `cloneUrl` is never placed on a command line alongside an unvalidated interpolation.
- Deferred: moving to argv-array command execution (no shell) would remove the whole class of risk but is a larger change than this plan.
