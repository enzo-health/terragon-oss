# GitHub Integration Architecture Redesign

| Field     | Value                                   |
| --------- | --------------------------------------- |
| Title     | GitHub Integration Architecture Redesign |
| Authors   | Codex + Tyler Sheffield                 |
| Status    | Proposed                                |
| Date      | 2026-04-17                              |
| Reviewers | TBD                                     |

---

## 1. Executive Summary

Terragon's GitHub integration already has useful primitives:

- webhook signature verification and delivery claiming in `apps/www/src/app/api/webhooks/github/route.ts`
- durable delivery claim state in `packages/shared/src/delivery-loop/store/webhook-delivery-store.ts`
- working PR authoring in `apps/www/src/agent/pull-request.ts`
- working check and comment publication in `apps/www/src/server-lib/delivery-loop/publication.ts`

The architecture problem is not that GitHub calls are failing in isolation. The problem is that GitHub identity, PR identity, thread identity, and workflow identity are represented in multiple places and stitched back together after the fact:

- `thread.githubRepoFullName`
- `thread.githubPRNumber`
- `github_pr.threadId`
- `delivery_workflow.repoFullName`
- `delivery_workflow.prNumber`
- `delivery_workflow.threadId`
- `delivery_workflow.currentHeadSha`

As a result:

1. webhook handlers contain orchestration logic instead of only ingress logic
2. feedback routing relies on heuristics instead of explicit ownership
3. app auth and user auth are chosen ad hoc at call sites
4. check publication exists in more than one subsystem
5. the product behaves as if there is one task per PR, while the data model allows multiple implicit owners

This redesign proposes a modular monolith with hard seams and one explicit product model:

- GitHub is the anchor
- a PR gets one canonical Terragon workspace
- Terragon runs are explicit child executions of that workspace
- comments, checks, and PR metadata are projections of Terragon state, not the primary state themselves

---

## 2. Goals

### 2.1 Primary goals

1. Give GitHub-triggered work one canonical owner model.
2. Make webhook handling fast, idempotent, and replayable.
3. Separate projection, orchestration, publication, and auth concerns.
4. Support multiple Terragon runs on one PR intentionally rather than accidentally.
5. Make product behavior legible to users and operators.

### 2.2 Non-goals

1. Preserve current thread-routing heuristics indefinitely.
2. Keep `owner/repo` as the primary identity key.
3. Let webhook handlers perform agent orchestration directly.
4. Keep check publication split across automations and delivery loop paths.
5. Push GitHub app authority into sandboxes.

### 2.3 Locked architectural decisions

This document assumes the following decisions are final for the target architecture:

1. **Modular monolith, not microservices**

   - the integration should live in one deployable app
   - seams should be enforced through modules, queues, and tables

2. **GitHub IDs are canonical**

   - `installation_id`, repo ID, PR node ID, review thread ID, comment ID, and `head_sha` are first-class
   - `owner/repo` remains display and lookup data, not the authoritative join key

3. **Webhook ingress is append-only**

   - ingress verifies, stores, claims, normalizes, and returns
   - ingress does not wake agents or write back to GitHub directly

4. **One canonical PR workspace**

   - every `(installation_id, repo_id, pr_id)` has at most one active Terragon workspace
   - multiple executions are modeled as runs or lanes inside that workspace

5. **`head_sha` is the causal boundary**

   - a new PR head is a new execution context
   - bursty events on the same SHA should coalesce

6. **GitHub surfaces are projections**

   - PR body, comments, replies, labels, and checks are downstream projections of Terragon state
   - they are not the primary runtime state machine

7. **Structured feedback before chat synthesis**

   - GitHub reviews and CI failures land in a review inbox first
   - conversion into agent prompts is a policy choice, not the only representation

8. **Sandboxes never hold app authority**

   - sandboxes may receive short-lived git credentials
   - sandboxes do not receive the app private key or broad GitHub API authority

9. **Lifecycle flow is one-way**

   - GitHub events may advance Terragon workflow state
   - archiving a Terragon task must not implicitly mutate GitHub unless that publication is explicit and owned

---

## 3. Current-State Findings

### 3.1 What is already strong

The current implementation already has valuable primitives worth preserving:

- webhook signature verification and own-bot suppression in `apps/www/src/app/api/webhooks/github/route.ts`
- durable delivery claiming and retry-friendly state in `packages/shared/src/delivery-loop/store/webhook-delivery-store.ts`
- working user-token and app-token support in `apps/www/src/lib/github.ts`
- solid PR creation and update behavior in `apps/www/src/agent/pull-request.ts`
- durable publication of canonical review surfaces in `apps/www/src/server-lib/delivery-loop/publication.ts`

### 3.2 What is currently weak

The current system still has structural weaknesses:

1. **No single GitHub domain boundary**

   - app auth, user auth, PR sync, mention handling, feedback routing, automation triggering, and publication are spread across:
   - `apps/www/src/lib/github.ts`
   - `apps/www/src/app/api/webhooks/github/handlers.ts`
   - `apps/www/src/app/api/webhooks/github/handle-app-mention.ts`
   - `apps/www/src/app/api/webhooks/github/route-feedback.ts`
   - `apps/www/src/agent/pull-request.ts`
   - `apps/www/src/server-lib/github.ts`
   - `apps/www/src/server-lib/delivery-loop/publication.ts`

2. **PR ownership is heuristic**

   - current routing falls through `github_pr.threadId`, existing threads, archived thread state, and PR author fallback
   - the system works by reconciliation, not by an explicit binding model

3. **Webhook truth is projection-dependent**

   - `handlePullRequestStatusChange()` returns early if there is no `github_pr` row
   - multiple webhook paths call `updateGitHubPR()` with `createIfNotFound: false`
   - GitHub is not treated as authoritative unless Terragon has already materialized local state

4. **Check publication is duplicated**

   - automations publish one family of checks in `apps/www/src/server-lib/github.ts`
   - delivery loop publishes another family in `apps/www/src/server-lib/delivery-loop/publication.ts`

5. **Repo connectivity is not modeled explicitly**

   - users experience an empty repo list rather than a structured state like:
   - account connected
   - app installed
   - write permission available
   - webhook healthy

6. **Product semantics are ambiguous**

   - docs and UX imply one coherent task per PR
   - actual routing allows multiple hidden owners and multiple thread shapes per PR

### 3.3 Critical seams that make the current system hard to evolve

```text
GitHub webhook
  -> handlers.ts
     -> update PR projection
     -> maybe run automations
     -> maybe resurrect delivery workflows
     -> maybe route feedback
     -> maybe create or reuse thread
     -> maybe call GitHub again for context

Result:
  ingress + enrichment + routing + orchestration + publication policy
  all touch one branchy surface
```

The hardest seams today are:

1. the auth seam
2. the event-to-domain seam
3. the thread-routing seam
4. the idempotency seam
5. the publication seam

---

## 4. Product Model

The redesign should make one product decision explicit:

> A PR has one canonical Terragon workspace. That workspace may have multiple runs or lanes.

This replaces the current implicit model where several threads may appear to own the same PR.

### 4.1 Canonical ownership semantics

These are the product decisions this redesign assumes:

1. one workspace per PR: yes
2. multiple runs are represented as lanes or runs inside that workspace, not peer workspaces
3. review and CI signals default to an inbox-first flow, with auto-run policy layered on top

In other words, the workspace is the canonical owner, lanes are execution modes inside that owner, and inbox routing is the default until policy explicitly decides to wake or start a run.

### 4.2 Proposed primitives

1. **GitHub Connection**

   - a user's GitHub OAuth connection
   - used only for explicitly user-attributed actions

2. **GitHub Installation**

   - Terragon app installation state for a GitHub account or org
   - owns background access and repo-scoped app authority

3. **GitHub Repository Projection**

   - normalized repo identity and health
   - keyed by installation ID and GitHub repo ID

4. **PR Workspace**

   - canonical Terragon owner for a GitHub PR
   - keyed by `(installation_id, repo_id, pr_id)`

5. **Workspace Run**

   - one Terragon execution inside a workspace
   - keyed by `(workspace_id, lane, head_sha, attempt)`

6. **Review Inbox Item**

   - structured GitHub feedback event
   - review comment, review submission, or CI signal

7. **GitHub Publication**

   - durable desired state for outbound comments, replies, checks, labels, or PR metadata

### 4.2 Workspace model

```text
GitHub PR
  -> PR Workspace
     -> Run: authoring @ SHA A
     -> Run: ci_repair @ SHA A
     -> Run: review_response @ SHA A
     -> Run: authoring @ SHA B

GitHub comments/checks/reviews
  -> Review Inbox Items on the workspace
  -> policy decides:
     - attach to existing run
     - wake suspended run
     - create new run in a lane
```

### 4.3 Lanes

The system should support explicit lanes rather than implicit thread types:

- `authoring`
- `mention_follow_up`
- `ci_repair`
- `review_response`
- `automation`

These are not separate workspaces. They are scoped execution contexts inside one workspace.

---

## 5. Design Principles

1. **GitHub facts first**

   - GitHub events and GitHub IDs define the anchor model
   - Terragon binds to that model explicitly

2. **One canonical owner per surface**

   - every PR has one workspace
   - every review thread or comment binds to a workspace intentionally

3. **Fast ingress, slow orchestration elsewhere**

   - webhook handlers validate and persist only
   - everything else runs through queues or coordinator ticks

4. **Explicit binding over inference**

   - the system should not guess the owner by scanning old threads
   - binding decisions should be stored as facts

5. **Short-lived credentials**

   - issue repo-scoped credentials as needed
   - centralize refresh and auditing

6. **One publisher**

   - all outbound GitHub writes flow through one publishing subsystem
   - retries, idempotency, batching, and rate-limit behavior live there

7. **Structured feedback before AI prompting**

   - GitHub feedback should be inspectable by operators and users
   - agent wake-up is a secondary policy step

8. **Replayability and operator clarity**

   - every inbound delivery, normalized event, routing decision, and outbound mutation should be reconstructable

---

## 6. Target Architecture

### 6.1 High-level architecture

```text
GitHub Webhooks
  -> Webhook Ingress
     -> raw delivery log
     -> delivery claim ledger
     -> normalized GitHub events
        -> GitHub projections
        -> workspace binding coordinator
        -> agent orchestrator
        -> GitHub publisher
        -> sandbox credential broker
```

### 6.2 Module boundaries

#### A. Webhook ingress

Responsibilities:

- verify `X-Hub-Signature-256`
- record raw payload and headers
- claim `X-GitHub-Delivery`
- emit normalized internal events
- return immediately

Must not do:

- agent orchestration
- GitHub writes
- ownership inference
- PR-thread reconciliation

#### B. Projection layer

Responsibilities:

- maintain installation projection
- maintain repo projection
- maintain PR projection
- maintain review-thread and comment projections where needed
- maintain current `head_sha`

Key rule:

- projections are keyed by GitHub IDs first
- repo slug changes are projection updates, not identity breaks

#### C. Workspace binding coordinator

Responsibilities:

- map GitHub surfaces to a canonical PR workspace
- create explicit bindings for:
  - PR
  - review thread
  - review comment
  - issue comment mentioning Terragon
  - check failure
- store routing reason, lane, and `head_sha`

This replaces the current owner-resolution fallthrough logic in `route-feedback.ts`.

#### D. Agent orchestrator

Responsibilities:

- decide whether a signal:
  - appends to inbox only
  - wakes a paused run
  - starts a new run
  - is coalesced as duplicate activity
- coalesce bursty GitHub events on the same `head_sha`
- enforce one active run per workspace lane when desired

#### E. GitHub publisher

Responsibilities:

- own all outbound mutations:
  - comments
  - replies
  - labels
  - PR title/body updates
  - check runs
- dedupe by logical publication identity
- batch annotations and updates
- handle retries and rate limits centrally

#### F. Sandbox credential broker

Responsibilities:

- issue short-lived repo-scoped git credentials to sandboxes
- refresh centrally
- revoke by expiry
- audit issuance by run and workspace

Must not do:

- general GitHub publication
- webhook handling

### 6.3 Current-to-target mapping

| Current surface | Problem | Target owner |
| --------------- | ------- | ------------ |
| `app/api/webhooks/github/route.ts` | good ingress, but event handling is too close downstream | keep as ingress only |
| `app/api/webhooks/github/handlers.ts` | monolithic branch table | split into normalizer, coordinator, publisher commands |
| `app/api/webhooks/github/handle-app-mention.ts` | mention routing owns workspace behavior | move routing into binding coordinator |
| `app/api/webhooks/github/route-feedback.ts` | ownership inferred heuristically | replace with explicit bindings + inbox |
| `lib/github.ts` | mixed auth, helpers, sync, author checks, association | split into auth broker, projection refresh, repo metadata client |
| `server-lib/github.ts` | automation-specific check publication | merge into central publisher |
| `server-lib/delivery-loop/publication.ts` | separate canonical publication system | keep concepts, move under shared publisher |

---

## 7. Proposed Data Model

This is not intended to be a full schema definition. It is the target logical model.

### 7.1 Ingress and event tables

1. `github_delivery`

   - `delivery_id`
   - `event_type`
   - `installation_id`
   - raw payload
   - claim state
   - completion state

2. `github_normalized_event`

   - `event_id`
   - `delivery_id`
   - `kind`
   - GitHub object IDs
   - `head_sha`
   - normalized payload

### 7.2 Projection tables

1. `github_installation_projection`

   - installation ID
   - owner/account metadata
   - permissions
   - suspension state
   - webhook health fields

2. `github_repo_projection`

   - repo ID
   - installation ID
   - current slug
   - default branch
   - read/write/admin capabilities

3. `github_pr_projection`

   - PR node ID
   - repo ID
   - number
   - open/draft/merged/closed state
   - base ref
   - head ref
   - head sha
   - review summary
   - CI summary

### 7.3 Workspace tables

1. `github_pr_workspace`

   - workspace ID
   - installation ID
   - repo ID
   - PR node ID
   - canonical state
   - current head sha
   - operator-visible health

2. `github_surface_binding`

   - binding ID
   - workspace ID
   - surface kind
   - surface GitHub ID
   - lane
   - routing reason
   - bound at sha

3. `github_workspace_run`

   - run ID
   - workspace ID
   - lane
   - head sha
   - attempt
   - run state
   - owning thread or execution reference

4. `github_review_inbox_item`

   - inbox item ID
   - workspace ID
   - source event ID
   - source surface ID
   - category: `review_comment`, `review_summary`, `ci_failure`, `ci_recovery`, `mention`
   - structured payload
   - resolution state
   - attached run ID if consumed

### 7.4 Publication tables

1. `github_publication`

   - publication ID
   - workspace ID
   - run ID nullable
   - target kind
   - logical publication key
   - desired payload
   - latest published GitHub ID
   - retry state

2. `github_check_publication`

   - logical check identity by `(repo_id, head_sha, publisher_kind)`
   - check run ID
   - status machine

### 7.5 Credentials table

1. `github_sandbox_credential_lease`

   - lease ID
   - run ID
   - repo ID
   - expires at
   - scope

---

## 8. Event Model and Orchestration

### 8.1 Normalized event kinds

The normalized layer should use closed event unions, for example:

- `installation_added`
- `installation_removed`
- `installation_permissions_changed`
- `pr_opened`
- `pr_reopened`
- `pr_closed`
- `pr_head_updated`
- `app_mentioned`
- `review_submitted`
- `review_comment_added`
- `check_run_completed`
- `check_suite_completed`

### 8.2 Commands

Normalized events should drive commands such as:

- `refresh_repo_projection`
- `refresh_pr_projection`
- `bind_surface_to_workspace`
- `create_review_inbox_item`
- `start_workspace_run`
- `resume_workspace_run`
- `publish_check_progress`
- `publish_review_response`

### 8.3 Coalescing rules

1. same workspace
2. same lane
3. same `head_sha`
4. same trigger category

If all four match, the default should be:

- append inbox items
- avoid spawning a new run

### 8.4 Idempotency model

#### Ingress idempotency

- keyed by `X-GitHub-Delivery`
- durable states:
  - `claimed`
  - `completed`
  - `released`

#### Domain idempotency

- keyed by natural GitHub facts such as:
  - `(installation_id, repo_id, pr_id, head_sha, trigger_type, trigger_object_id)`

#### Publication idempotency

- keyed by logical outbound identity, not by attempt count
- example:
  - one Terragon CI check per `(repo_id, head_sha, publisher_kind)`

---

## 9. Auth and Credential Strategy

### 9.1 App auth

Use app installation tokens for:

- webhook-triggered background work
- publication
- repo projection refresh
- review-thread and check introspection

Requirements:

- mint centrally
- scope to repo where possible
- cache slightly below token expiry
- track installation health

### 9.2 User auth

Use user tokens only for:

- explicitly user-attributed actions
- user-facing repo discovery
- actions where Terragon must act as the user

Requirements:

- refresh centrally
- encrypt refresh tokens
- disable quickly on revocation or auth failure

### 9.3 Sandbox credentials

Use broker-issued short-lived git credentials for:

- fetch
- push
- branch operations

Never send into sandboxes:

- app private key
- long-lived general-purpose GitHub access tokens

---

## 10. User and Operator Flows

### 10.1 Repo connectivity

The product should show explicit repo health:

- GitHub account connected
- Terragon app installed on repo
- repo is readable
- repo is writable
- webhook deliveries healthy
- user reauth required or not

This replaces today's empty-repo-list failure mode.

### 10.2 Mentions

```text
GitHub mention
  -> normalized event
  -> bind to PR workspace
  -> create inbox item
  -> mention policy decides:
     - wake existing run
     - start mention_follow_up lane
     - inbox only
```

### 10.3 Reviews and CI failures

```text
Review comment / failed check
  -> normalized event
  -> bind to workspace
  -> create inbox item
  -> if policy = auto:
       start review_response or ci_repair lane
     else:
       show actionable feedback in Terragon
```

### 10.4 PR publication

```text
Workspace run produces change
  -> publish command
  -> publisher updates PR metadata
  -> publisher updates logical check run
  -> projections refresh from GitHub
```

### 10.5 Merge and archive

Desired rule:

- merging or closing the PR may transition the workspace
- archiving a Terragon run or task does not silently mutate GitHub

---

## 11. Migration Plan

### 11.1 Phase 0: lock product semantics

Before implementation starts, confirm:

1. one workspace per PR
2. multiple runs are lanes or runs inside that workspace, not peer workspaces
3. review and CI signals default to inbox-first, with auto-run policy layered on top

### 11.2 Phase 1: add canonical projections

1. add installation, repo, and PR projection tables
2. start storing GitHub IDs alongside current slug-based keys
3. dual-write projections from existing webhook paths

### 11.3 Phase 2: normalize events

1. keep current ingress route
2. emit normalized GitHub events after claim
3. move branch-heavy logic out of `handlers.ts`

### 11.4 Phase 3: add workspace and binding model

1. create `github_pr_workspace`
2. create `github_surface_binding`
3. create `github_workspace_run`
4. route new mention, review, and CI flows through bindings first

### 11.5 Phase 4: centralize publisher

1. move automation check publication into one publisher
2. move delivery loop comment and check publication into same publisher
3. use logical publication keys

### 11.6 Phase 5: deprecate heuristic routing

Remove or downgrade the following as primary ownership mechanisms:

- `github_pr.threadId`
- thread scanning for owner resolution
- message-marker dedupe as the main feedback dedupe strategy
- separate check publication systems

### 11.7 Phase 6: move sandbox auth to broker

1. add broker-issued short-lived git credentials
2. stop relying on broad GitHub credentials inside sandboxes

---

## 12. Open Questions

These are the real product questions that should be answered before coding:

1. Should review and CI feedback auto-start agent work, or only create actionable Terragon inbox items until a user confirms?
2. Should mention routing policy be global, per repo, or per automation?
3. Should archived workspaces reopen on new GitHub feedback, or should new feedback always fork a new run?
4. Should `Ready for review` require passing checks, non-failing checks, or remain a manual user choice?
5. What should happen when a public GitHub user mentions Terragon on a repo with no mapped Terragon identity?

---

## 13. Why This Shape Is Better

This redesign fixes the actual root problem:

- GitHub identity becomes canonical
- PR ownership becomes explicit
- multiple Terragon runs on one PR become intentional
- outbound GitHub writes become one subsystem
- auth selection stops leaking across call sites
- operator visibility improves because routing and publication are durable facts

The key change is not a prettier module tree. The key change is replacing post hoc reconciliation with a first-class binding model.

---

## 14. Source Material

### 14.1 Current code paths

- `apps/www/src/app/api/webhooks/github/route.ts`
- `apps/www/src/app/api/webhooks/github/handlers.ts`
- `apps/www/src/app/api/webhooks/github/handle-app-mention.ts`
- `apps/www/src/app/api/webhooks/github/route-feedback.ts`
- `apps/www/src/lib/github.ts`
- `apps/www/src/agent/pull-request.ts`
- `apps/www/src/server-lib/github.ts`
- `apps/www/src/server-lib/automations.ts`
- `apps/www/src/server-lib/delivery-loop/publication.ts`
- `packages/shared/src/model/github.ts`
- `packages/shared/src/delivery-loop/store/webhook-delivery-store.ts`

### 14.2 Internal references

- `docs/delivery-loop-architecture-redesign.md`
- `apps/docs/content/docs/integrations/github-integration.mdx`

### 14.3 External references

- GitHub App best practices: <https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app>
- Webhook best practices: <https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks>
- Validating webhook deliveries: <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>
- Installation tokens: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>
- User token refresh: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens>
- REST API best practices: <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- Rate limits: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- Check runs: <https://docs.github.com/en/rest/checks/runs>
- Failed webhook delivery handling: <https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries>
- Probot reference: <https://github.com/probot/probot>
- Reviewdog check-run publication reference: <https://github.com/reviewdog/reviewdog>
