# Plan: Execute GitHub Integration Architecture Redesign

**Generated:** 2026-04-17  
**Estimated Complexity:** Very High  
**Execution Mode:** `subagent-driven-development`  
**Primary source:** `docs/github-integration-architecture-redesign.md`  
**Implementation branch strategy:** Use a fresh implementation branch after this docs branch lands

---

## Overview

This plan turns the GitHub architecture redesign into an execution sequence that is compatible with subagent-driven development.

The target end state is:

- one canonical PR workspace per GitHub PR
- explicit workspace runs/lanes rather than implicit multi-thread ownership
- webhook ingress limited to verification, claiming, persistence, and normalization
- GitHub IDs as first-class identity keys
- one central publisher for comments, replies, labels, checks, and PR metadata
- one broker for short-lived sandbox git credentials

This plan intentionally does **not** treat the work as a refactor-in-place of `handlers.ts`. The main move is to build new ownership primitives and cut traffic over gradually.

### High-level sequencing

```text
1. Projections
   -> store canonical GitHub identities and health

2. Workspace + binding domain
   -> give PRs and GitHub surfaces one explicit Terragon owner

3. Normalized events
   -> separate webhook ingress from orchestration

4. Review inbox + run orchestration
   -> stop synthesizing routing decisions from thread heuristics

5. Central publisher
   -> unify all outbound GitHub mutations

6. Sandbox credential broker
   -> remove broad GitHub authority from sandboxes

7. UI and operator surfaces
   -> make health, routing, and failures visible

8. Cutover + cleanup
   -> switch reads/writes and delete heuristics
```

### Execution rules

1. No task should extend the old heuristic owner-resolution model unless the task explicitly exists to preserve compatibility during migration.
2. New identity joins should prefer GitHub IDs over `owner/repo`.
3. New outbound GitHub writes should go through the new publisher once that task lands.
4. No task should require sandboxes to hold app authority.
5. Every task must include tests or a verifiable operator-facing check.

---

## Locked Product Decisions

These decisions should be treated as fixed while executing this plan:

1. A GitHub PR has one canonical Terragon workspace.
2. Multiple Terragon executions on the same PR are represented as explicit runs or lanes inside that workspace.
3. `head_sha` is the causal boundary for coalescing and run identity.
4. Review and CI feedback land in a structured review inbox before optional conversion into agent prompts.
5. GitHub comments/checks/PR metadata are projections of Terragon state, not the primary state machine.

If any of these decisions change, stop execution and rewrite the plan first.

---

## Sprint 0: Pre-Implementation Guardrails

**Goal:** lock semantics, identify migration constraints, and avoid implementing the wrong product model.

**Demo/Validation:**

- the architecture doc and this plan agree on one canonical owner model
- a short migration risk note exists for current live tables and flows

### Task 0.1: Confirm canonical ownership semantics

- **Location:** docs only
- **Description:** Record the three locked product decisions in the architecture doc or a short addendum:
  - one workspace per PR: yes
  - multiple runs represented as lanes/runs, not peer workspaces
  - review/CI signals default to inbox-first, with auto-run policy layered on top
- **Dependencies:** none
- **Acceptance Criteria:**
  - the three answers are explicit and unambiguous
  - the answers match this implementation plan
- **Validation:** manual review; no conflicting wording remains in the docs

### Task 0.2: Inventory current sources of GitHub ownership truth

- **Location:** `apps/www/src/lib/github.ts`, `apps/www/src/app/api/webhooks/github/route-feedback.ts`, `apps/www/src/app/api/webhooks/github/handle-app-mention.ts`, `apps/www/src/app/api/webhooks/github/handlers.ts`, `packages/shared/src/model/github.ts`
- **Description:** Create a concrete migration checklist enumerating every place where PR ownership or routing currently depends on:
  - `thread.githubPRNumber`
  - `thread.githubRepoFullName`
  - `github_pr.threadId`
  - `delivery_workflow.prNumber`
  - `delivery_workflow.threadId`
  - PR author fallback
  - thread scans / archived-thread heuristics
- **Dependencies:** 0.1
- **Acceptance Criteria:**
  - each current ownership mechanism is listed with file references
  - each has a future replacement target
- **Validation:** grep/read-through confirms every known source of truth is covered

---

## Sprint 1: Canonical GitHub Projections

**Goal:** add durable projections keyed by GitHub IDs so the new system does not depend on repo slug and thread heuristics.

**Demo/Validation:**

- new projection tables exist
- webhook traffic can shadow-write them
- a refresh path can rehydrate projections from GitHub APIs

### Task 1.1: Add installation, repo, and PR projection tables

- **Location:** `packages/shared/src/db/schema.ts`, `packages/shared/src/db/types.ts`, new migration files, new shared model files
- **Description:** Add projection tables for:
  - installation
  - repo
  - PR
  Each table should store GitHub-native IDs as canonical identifiers, with slug/name fields as mutable projection data.
- **Dependencies:** 0.2
- **Acceptance Criteria:**
  - tables exist with stable GitHub IDs and timestamps
  - schema is typed in shared models
  - repo slug is no longer the only join surface for new code
- **Validation:** migration applies locally; shared types compile

### Task 1.2: Implement projection refresh clients

- **Location:** new GitHub projection module(s) under `apps/www/src/server-lib/` and/or `packages/shared/src/model/`
- **Description:** Create projection refresh functions that can fetch and persist:
  - installation metadata and permissions
  - repo metadata and default branch
  - PR metadata including `head_sha`, base/head refs, open/draft/merged/closed state
- **Dependencies:** 1.1
- **Acceptance Criteria:**
  - functions are isolated from webhook handlers
  - each refresh path has tests
  - refresh can run from webhook-triggered paths or manual repair paths
- **Validation:** unit/integration tests pass for refresh behavior

### Task 1.3: Shadow-write projections from current webhook flows

- **Location:** `apps/www/src/app/api/webhooks/github/route.ts`, replacement normalizer glue as needed
- **Description:** Without changing primary behavior yet, update current webhook processing so GitHub webhook deliveries refresh or enqueue projection refreshes for installation/repo/PR state.
- **Dependencies:** 1.2
- **Acceptance Criteria:**
  - existing flows keep working
  - projection rows populate for webhook-covered repos and PRs
  - failures in projection refresh are isolated and observable
- **Validation:** replay or test fixture updates projection state without altering current routing outputs

---

## Sprint 2: PR Workspace and Surface Binding Domain

**Goal:** replace implicit PR ownership with explicit workspace and binding records.

**Demo/Validation:**

- a PR can be resolved to one workspace by canonical IDs
- review comments, review threads, mentions, and check failures can bind to that workspace explicitly

### Task 2.1: Add workspace and run tables

- **Location:** `packages/shared/src/db/schema.ts`, migration files, shared model layer
- **Description:** Add:
  - `github_pr_workspace`
  - `github_workspace_run`
  Model one canonical workspace per `(installation_id, repo_id, pr_id)` and explicit runs/lanes under it.
- **Dependencies:** 1.1
- **Acceptance Criteria:**
  - unique constraint enforces one workspace per PR
  - runs are keyed by workspace, lane, head SHA, and attempt
  - shared model helpers exist for create/read/update
- **Validation:** migration and model tests pass

### Task 2.2: Add surface binding table and binding helpers

- **Location:** `packages/shared/src/db/schema.ts`, shared model layer, new server-lib module
- **Description:** Add `github_surface_binding` to bind workspace ownership for:
  - PR
  - review thread
  - review comment
  - issue comment mention
  - check run / check suite signals
- **Dependencies:** 2.1
- **Acceptance Criteria:**
  - binding helpers support create, upsert, and lookup by GitHub surface
  - binding captures lane, routing reason, and bound `head_sha`
- **Validation:** tests prove one bound surface resolves to one workspace deterministically

### Task 2.3: Introduce workspace bootstrap logic for existing PR-linked tasks

- **Location:** new workspace bootstrap module plus integration points in PR creation and existing PR association
- **Description:** When Terragon creates or attaches to a PR, create or find the canonical workspace and link the current thread/run into it instead of relying only on `github_pr.threadId`.
- **Dependencies:** 2.2
- **Acceptance Criteria:**
  - PR creation path creates or reuses workspace
  - existing PR association path also resolves workspace
  - new code does not require `github_pr.threadId` to understand ownership
- **Validation:** PR creation/association tests prove workspace linkage

---

## Sprint 3: Normalized GitHub Events

**Goal:** separate webhook ingress from orchestration by introducing normalized internal events.

**Demo/Validation:**

- ingress verifies, claims, persists, and emits normalized events only
- downstream processing works from normalized events rather than raw webhook payload branching

### Task 3.1: Add normalized event table and event types

- **Location:** shared schema/types plus new normalizer module
- **Description:** Add a durable `github_normalized_event` table and closed event unions for:
  - `pr_opened`
  - `pr_reopened`
  - `pr_closed`
  - `pr_head_updated`
  - `app_mentioned`
  - `review_submitted`
  - `review_comment_added`
  - `check_run_completed`
  - `check_suite_completed`
  - installation-level events as needed
- **Dependencies:** 1.3
- **Acceptance Criteria:**
  - normalized events contain canonical GitHub IDs and `head_sha` when relevant
  - event unions are closed and typed
- **Validation:** tests convert fixture payloads into normalized events

### Task 3.2: Move branching logic out of `handlers.ts`

- **Location:** `apps/www/src/app/api/webhooks/github/handlers.ts` and new normalizer/coordinator modules
- **Description:** Refactor webhook handler paths so `handlers.ts` becomes an adapter that emits normalized events or delegates to dedicated modules, rather than being the long-term owner of routing and orchestration logic.
- **Dependencies:** 3.1
- **Acceptance Criteria:**
  - `handlers.ts` shrinks materially
  - raw webhook branching is no longer the place where ownership is decided
  - ingress and normalization remain backward compatible during migration
- **Validation:** existing webhook tests pass; diff shows orchestration code moved out

---

## Sprint 4: Review Inbox and Run Orchestration

**Goal:** stop routing GitHub feedback directly into chat heuristics and introduce an inbox-first model with explicit run policy.

**Demo/Validation:**

- GitHub review/check signals create inbox items on a workspace
- policy chooses inbox-only vs wake-run vs new-run

### Task 4.1: Add review inbox table and structured payload model

- **Location:** shared schema/types/model layer
- **Description:** Add `github_review_inbox_item` with category and structured payload support for:
  - mention
  - review comment
  - review summary
  - CI failure
  - CI recovery
- **Dependencies:** 2.2, 3.1
- **Acceptance Criteria:**
  - inbox items are bound to workspaces
  - payload is structured enough to avoid chat-string parsing as the primary storage format
- **Validation:** tests create and resolve inbox items by workspace

### Task 4.2: Replace owner-resolution heuristics with binding-driven routing

- **Location:** `apps/www/src/app/api/webhooks/github/route-feedback.ts`, `apps/www/src/app/api/webhooks/github/handle-app-mention.ts`, new coordinator module
- **Description:** Replace routing that currently scans existing threads and PR author fallbacks with:
  - surface binding lookup
  - workspace resolution
  - inbox creation
  - explicit run policy
- **Dependencies:** 4.1
- **Acceptance Criteria:**
  - new routing does not depend on `github_pr.threadId`
  - review/check/mention flows all resolve via workspace + bindings
  - fallback behavior is explicit and operator-visible when binding is missing
- **Validation:** updated routing tests prove deterministic workspace resolution

### Task 4.3: Implement run policy and lane selection

- **Location:** new orchestration policy module plus integration with Terragon thread/run creation
- **Description:** Add policy that decides, given a workspace, lane, and `head_sha`, whether to:
  - attach to existing active run
  - wake a paused run
  - create a new run
  - leave feedback in inbox only
- **Dependencies:** 4.2
- **Acceptance Criteria:**
  - policy is explicit and testable
  - same-SHA bursty events coalesce
  - runs are lane-scoped, not ad hoc thread-scoped
- **Validation:** tests cover mention, review, and CI scenarios

---

## Sprint 5: Central GitHub Publisher

**Goal:** unify all outbound GitHub writes behind one publisher and one idempotency model.

**Demo/Validation:**

- PR metadata, comments/replies, labels, and checks all flow through one publication system
- duplicate check families are removed

### Task 5.1: Add durable publication model

- **Location:** shared schema/model layer plus publisher module
- **Description:** Add `github_publication` and any supporting types required to represent desired outbound GitHub mutations with logical publication keys.
- **Dependencies:** 2.1, 3.1
- **Acceptance Criteria:**
  - publications are durable
  - logical publication key supports idempotent retries
  - failure state is inspectable
- **Validation:** publisher model tests pass

### Task 5.2: Unify check publication

- **Location:** `apps/www/src/server-lib/github.ts`, `apps/www/src/server-lib/delivery-loop/publication.ts`, new publisher
- **Description:** Remove the split between automation check publication and delivery-loop canonical check publication by moving both to one logical check-run publisher keyed by `(repo_id, head_sha, publisher_kind)`.
- **Dependencies:** 5.1
- **Acceptance Criteria:**
  - one logical Terragon check exists per intended publishing kind
  - retries update the same check instead of creating new ones
  - old code paths delegate to the new publisher
- **Validation:** tests confirm repeated publish attempts update rather than duplicate

### Task 5.3: Unify comment and PR metadata publication

- **Location:** new publisher plus current PR/comment publication call sites
- **Description:** Move PR body/title updates, canonical status comments, replies, and label mutations into the same publisher boundary.
- **Dependencies:** 5.2
- **Acceptance Criteria:**
  - no new direct Octokit write path remains outside the publisher for these surfaces
  - publisher supports retries and 404 reconciliation behavior
- **Validation:** grep/read-through confirms call sites use publisher

---

## Sprint 6: Sandbox Credential Broker

**Goal:** stop relying on broad GitHub authority inside sandboxes.

**Demo/Validation:**

- sandboxes can push/fetch with short-lived broker-issued credentials
- app authority stays outside the sandbox

### Task 6.1: Add broker-issued git credential leases

- **Location:** shared schema/model layer plus broker module
- **Description:** Add a lease model for short-lived repo-scoped git credentials issued to a run.
- **Dependencies:** 2.1
- **Acceptance Criteria:**
  - lease is scoped to repo/run
  - lease has explicit expiry and audit fields
- **Validation:** tests cover lease issue and expiry behavior

### Task 6.2: Integrate sandboxes with credential broker

- **Location:** sandbox setup code and relevant run bootstrap paths
- **Description:** Replace broad GitHub credential delivery with broker-issued short-lived credentials for git operations.
- **Dependencies:** 6.1
- **Acceptance Criteria:**
  - sandbox does not need app private key or broad API authority
  - push/fetch flows still work
- **Validation:** sandbox integration tests or controlled manual verification succeed

---

## Sprint 7: UI and Operator Surfaces

**Goal:** make the new model visible and operable rather than hiding it in database joins.

**Demo/Validation:**

- users can see repo/install health
- operators can see workspace binding and publication failures

### Task 7.1: Add repo/install health UI

- **Location:** GitHub settings surfaces, repo selectors, related server actions
- **Description:** Surface explicit states for:
  - GitHub account connected
  - app installed
  - repo readable
  - repo writable
  - webhook healthy
  - user reauth required
- **Dependencies:** 1.3
- **Acceptance Criteria:**
  - empty repo states become diagnosable
  - read-only vs writable repos are visually distinct
- **Validation:** UI tests or manual screenshots cover all states

### Task 7.2: Add workspace/inbox/operator visibility

- **Location:** admin/operator surfaces and relevant internal pages
- **Description:** Add visibility for:
  - workspace identity
  - current head SHA
  - active runs/lanes
  - inbox items
  - failed publications
  - missing bindings or fallback states
- **Dependencies:** 4.3, 5.3
- **Acceptance Criteria:**
  - an operator can understand why a GitHub event did or did not wake work
  - failed publication and missing binding states are not silent
- **Validation:** operator walkthrough confirms each state is inspectable

---

## Sprint 8: Cutover and Cleanup

**Goal:** switch reads and writes to the new model, then delete legacy ownership heuristics.

**Demo/Validation:**

- production behavior runs on workspaces/bindings/publisher
- legacy heuristic ownership paths are deleted or dormant

### Task 8.1: Cut read paths to workspace-first resolution

- **Location:** existing GitHub routing, PR lookup, feedback ingestion, quick-action surfaces
- **Description:** Switch primary read paths from thread-first or `github_pr.threadId`-first to workspace/binding-first resolution.
- **Dependencies:** 4.3, 5.3
- **Acceptance Criteria:**
  - routing and publication decisions no longer require thread scans as primary logic
  - workspaces are the main join surface for PR-bound work
- **Validation:** integration tests pass with legacy heuristic paths disabled in test mode

### Task 8.2: Remove or downgrade legacy ownership fields and heuristics

- **Location:** `packages/shared/src/model/github.ts`, `apps/www/src/app/api/webhooks/github/route-feedback.ts`, `apps/www/src/app/api/webhooks/github/handle-app-mention.ts`, related code paths
- **Description:** Remove or demote:
  - `github_pr.threadId` as a canonical owner
  - existing-thread scans as the primary owner-resolution mechanism
  - message-marker dedupe as the primary feedback-routing idempotency mechanism
  - split check publication systems
- **Dependencies:** 8.1
- **Acceptance Criteria:**
  - old heuristics are gone or clearly marked as temporary compatibility shims
  - architecture doc matches the actual code shape
- **Validation:** grep/read-through confirms deletions; tests still pass

### Task 8.3: Final architecture verification pass

- **Location:** full repo slice touched by this plan
- **Description:** Run a final review pass to confirm:
  - one canonical workspace per PR
  - one publisher boundary
  - one credential broker boundary
  - ingress limited to verification/claim/log/normalize
  - no hidden thread-owner heuristics remain
- **Dependencies:** 8.2
- **Acceptance Criteria:**
  - architecture invariants are test-backed or operator-verifiable
  - code review finds no regressions to old ownership model
- **Validation:** full verification checklist is green

---

## Subagent Dispatch Order

This sequence is optimized for `subagent-driven-development`:

1. `Task 1.1`
2. `Task 1.2`
3. `Task 1.3`
4. `Task 2.1`
5. `Task 2.2`
6. `Task 2.3`
7. `Task 3.1`
8. `Task 3.2`
9. `Task 4.1`
10. `Task 4.2`
11. `Task 4.3`
12. `Task 5.1`
13. `Task 5.2`
14. `Task 5.3`
15. `Task 6.1`
16. `Task 6.2`
17. `Task 7.1`
18. `Task 7.2`
19. `Task 8.1`
20. `Task 8.2`
21. `Task 8.3`

Do not dispatch multiple implementer subagents in parallel unless their write scopes are explicitly disjoint.

---

## Review Checkpoints

Every implementation task should pass three gates before marking complete:

1. **Implementer self-review**

   - what changed
   - tests run
   - open concerns

2. **Spec compliance review**

   - confirms the task did exactly what the plan asked
   - flags missing behavior or extra behavior

3. **Code quality review**

   - checks boundary quality, simplicity, naming, tests, and migration hygiene

No task advances until both reviews are green.

---

## Risks to Watch

1. Shadow-writing projections but forgetting to cut reads over, creating dead-state confidence.
2. Rebuilding ownership semantics while keeping thread-based fallback alive too long.
3. Shipping a new publisher boundary but allowing direct Octokit writes to continue proliferating.
4. Introducing workspace/runs while still letting product surfaces imply thread ownership.
5. Treating `owner/repo` as authoritative in new code out of convenience.

---

## Deliverables

When this plan is complete, the repo should have:

1. canonical GitHub projection tables
2. PR workspace, run, binding, and review inbox models
3. normalized webhook event pipeline
4. centralized GitHub publisher
5. sandbox credential broker
6. UI/operator surfaces for connectivity, routing, and publication health
7. removal of legacy heuristic ownership as the primary model
