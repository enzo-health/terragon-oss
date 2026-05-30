# Bake repos into environment snapshots (Daytona)

**Status:** Draft for review **Date:** 2026-05-29 **Scope:** Daytona provider only. Always boot from the latest base branch. Build eagerly on environment setup and refresh when the base branch advances.

## Problem

Every Daytona task that doesn't already have a warm snapshot clones the repo and runs the setup script during boot, which is the slow part of starting a task. The machinery to avoid this already exists but is half-wired: it builds lazily (so the first task on a repo is always cold), it never refreshes the baked commit (so tasks can start stale), and it leaks old snapshots in Daytona. This plan closes those three gaps so each repo you use boots from a pre-baked, fresh snapshot.

## What already exists (do not rebuild)

| Piece                 | Location                                                                                                                             | What it does                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Snapshot build        | `packages/sandbox/src/snapshot-builder.ts` → `buildRepoSnapshot()`                                                                   | Clones repo, installs deps, runs setup script, calls `daytona.snapshot.create()` |
| Lifecycle wrapper     | `apps/www/src/server-lib/environment-snapshot-build.ts` → `buildAndStoreEnvironmentSnapshot()`, `maybeTriggerSnapshotBuildForBoot()` | Persists `building → ready/failed`, reaps stale builds, debounces                |
| Storage               | `environment.snapshots` JSONB (`EnvironmentSnapshot[]`) in `packages/shared/src/db/schema.ts`                                        | One entry per `(provider, size, config-hash)`                                    |
| Selection at boot     | `getReadySnapshot()` in `packages/shared/src/model/environments.ts`; consumed at `apps/www/src/agent/sandbox.ts:866`                 | Picks a ready snapshot matching size + hashes                                    |
| Boot skips clone      | `packages/sandbox/src/setup.ts:236`                                                                                                  | When `snapshotTemplateId` is set, skips `gitCloneRepo()` and the setup script    |
| Manual build / delete | `apps/www/src/server-actions/environment-snapshot.ts` → `buildEnvironmentSnapshot`, `deleteEnvironmentSnapshot`                      | Settings-driven build and teardown                                               |
| Hash invalidation     | `computeSnapshotHashes()`                                                                                                            | Rebuilds when setup script, base template, env vars, or MCP config change        |

The hard parts — building the image, storing it, selecting it, skipping the clone — are done. The gaps below are the work.

## Gaps to close

| #   | Gap                                                                                                                                                  | Evidence                                                                                                        | Fix                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | **Baked repo goes stale.** Boot from a snapshot only runs `git remote set-url`; no fetch/reset, so the working tree sits at the build-time commit.   | `setup.ts:239-248`                                                                                              | Add incremental `git fetch` + `git reset --hard origin/<baseBranch>` on the snapshot boot path, before branch creation. |
| 2   | **First task is always cold.** Snapshots only build lazily after a boot.                                                                             | `maybeTriggerSnapshotBuildForBoot` fires post-boot only                                                         | Trigger `buildAndStoreEnvironmentSnapshot` when an environment is created/configured.                                   |
| 3   | **No refresh as base branch moves.** Rebuild only triggers on config-hash change, never on new commits.                                              | `computeSnapshotHashes()` ignores commit SHA                                                                    | Add a refresh trigger on `push` to the base branch (webhook) + a staleness cron fallback.                               |
| 4   | **Old snapshots leak.** A rebuild writes a new `repo-…-<timestamp>` snapshot and overwrites the DB entry; the previous Daytona snapshot is orphaned. | `updateEnvironmentSnapshot` replaces in place; `deleteRepoSnapshot` only called from the Settings delete action | Delete the superseded snapshot after a successful rebuild.                                                              |

## Design decisions (locked)

- **Freshness:** Always reset to `origin/<baseBranch>` on boot. Cheap because the snapshot already holds nearly every object — the fetch is incremental.
- **Build timing:** Eager on environment setup **and** refresh on push to the base branch.
- **Provider:** Daytona only. E2B (the current DB default, `schema.ts:269`) and Docker are out of scope; tasks on those providers keep today's behavior untouched.

## Plan

### Phase 1 — Fresh repo on every snapshot boot (Gap 1)

The correctness fix. Without it, eager/refresh builds just make stale starts faster.

1. In `setupSandboxOneTime` (`packages/sandbox/src/setup.ts`), on the `snapshotTemplateId` branch, after `git remote set-url`, fetch and hard-reset to the base branch:

- `git fetch --filter=blob:none origin <baseBranch>`
- `git reset --hard origin/<baseBranch>`
- Then let the existing `createNewBranch` / `git clean -fxd` run so the new branch forks from the fresh base, not the baked commit.

2. Thread `repoBaseBranchName` into this path (it already reaches `gitCloneRepo`; confirm it's on `CreateSandboxOptions` here too).

3. Failure handling: if the fetch fails (e.g. branch deleted), fall back to the baked commit and log — never hard-fail the boot.

**Acceptance:** Boot a task from a ready snapshot after pushing a new commit to the base branch; the sandbox HEAD's merge-base matches the new `origin/<baseBranch>` tip, and boot still skips the full clone.

### Phase 2 — Eager build on environment setup (Gap 2)

1. Find the environment create/update path (the server action behind the Settings "environment" form; `updateEnvironment` in `packages/shared/src/model/environments.ts` is the DB write).

2. After a successful create/update for a non-global environment with a `repoFullName`, call `buildAndStoreEnvironmentSnapshot` (reuse the exact argument assembly already in `buildEnvironmentSnapshot`, `environment-snapshot.ts:35-81`).

3. Debounce against an in-progress build (the `maybeTriggerSnapshotBuildForBoot` debounce logic already exists — extract or reuse it so a save during a build doesn't stack a duplicate).

4. Default size: build the size the environment will actually use. If both sizes are possible, build `small` eagerly and leave `large` to lazy/boot-trigger to bound build cost.

**Acceptance:** Configure a fresh environment; without ever starting a task, a `ready` snapshot appears for that repo, and the first task boots warm.

### Phase 3 — Refresh on base-branch push (Gap 3)

1. **Subscribe to** `push`**.** The GitHub App webhook (`apps/www/src/app/api/webhooks/github/route.ts`) currently handles `pull_request.*` only — `push` is not in the subscribed events (line ~62-76). Add `push` to both the GitHub App subscription and the `webhooks.on(...)` handlers. (Check `route-shadow-refresh.ts` first — a "shadow refresh" path may already touch this.)

2. On `push` to a repo's default/base branch, for every environment matching that `repoFullName` with a `ready` snapshot, enqueue a rebuild via `buildAndStoreEnvironmentSnapshot` (background, `waitUntil`).

3. Ignore Terragon's own pushes (the route already has a self-push guard around line 361 — reuse it).

4. **Cron fallback** for missed/disabled webhooks: a periodic job (Vercel cron, mirrors the existing cron setup) that rebuilds snapshots whose `builtAt` is older than a threshold (e.g. 24h) and whose base branch tip has moved.

**Acceptance:** Push a commit to a watched repo's base branch; within one build cycle the environment's snapshot `builtAt` advances and the new snapshot contains the pushed commit.

### Phase 4 — Delete superseded snapshots (Gap 4)

1. In `buildAndStoreEnvironmentSnapshot`, capture the prior `snapshotName` for that `(size, hashes)` slot before overwriting.

2. After the new build reaches `ready`, call `deleteRepoSnapshot(oldName)` (best-effort; log on failure, already the pattern in `deleteEnvironmentSnapshot`).

3. **Orphan reaper:** extend the staleness cron (Phase 3) to list Daytona snapshots named `repo-*` with no matching `ready` DB entry and delete them, bounding unbounded growth from crashed builds.

**Acceptance:** Trigger two rebuilds of the same environment; Daytona retains exactly one `repo-…` snapshot for that slot, and orphans from a killed build get reaped on the next cron run.

## Risks & open questions

- **Registry auth for** `Image.base(ref)` — `snapshot-builder.ts:48-50` warns that pulling the base template requires Daytona build workers to have registry credentials (service-account key, not a personal key). Eager + push builds increase build volume, so confirm the production key is a service account before turning on Phase 3 broadly.
- **Build cost / concurrency** — eager + push builds multiply Daytona build minutes. The debounce (Phase 2/3) and `small`-only eager default (Phase 2) bound this; consider a per-user/in-flight build cap if volume spikes.
- `push` **webhook scope** — adding `push` to the GitHub App fires for _every_ push to _every_ installed repo. Filter to base branches of repos that actually have an environment before doing any work, to avoid waking the build path on unrelated pushes.
- **Branch coverage** — snapshots are keyed to the base branch only. Tasks branching off a non-default base still clone cold. Out of scope here; note as a follow-up if it matters.

## Rollout

1. Phase 1 behind no flag — it's a strict correctness improvement to an existing path; ship and verify with the Daytona integration boot.

2. Phases 2-4 behind a feature flag (reuse the `daytonaOptionsForSandboxProvider` flag family in `feature-flags-definitions.ts`, or add `eagerEnvironmentSnapshots`) so eager/push builds can be enabled per-user first.

3. Verify with `pnpm tsc-check` and the sandbox package tests (`pnpm -C packages/sandbox test`); add unit coverage for the Phase 1 fetch/reset path and the Phase 3 push filter.
