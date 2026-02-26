# Overview

Build an L1 autonomous SDLC loop in Terragon for explicitly enrolled task threads/PRs. The loop drives one PR head SHA to `human_review_ready` and then `done` with replay-safe gate state and idempotent side effects.

**Determinism in this epic**

- Deterministic progression means state transitions are reproducible from persisted inputs and policies.
- Temporal gates use immutable evaluations + mutable current-state pointers.
- Model prose may vary; gate outcomes use schema-validated booleans and persisted finding identities.

# Scope

## In scope

- Single-task L1 loop.
- Enrollment constraints + coordinator ownership for enrolled flows.
- FSM with stale-signal suppression and explicit PR lifecycle transitions.
- Deep/Carmack, CI, unresolved review-thread gates.
- Video capture + secure publication.
- Signature-safe delivery ingestion, fenced locking, transactional outbox, retention policy, full auditability.

## Out of scope

- L2 DAG orchestration.
- Non-GitHub providers.

# Existing Reuse Points

- Runtime hooks: `apps/www/src/server-lib/handle-daemon-event.ts`, `apps/www/src/server-lib/process-follow-up-queue.ts`, `apps/www/src/server-lib/follow-up.ts`
- Webhook ingress/routing: `apps/www/src/app/api/webhooks/github/handlers.ts`, `apps/www/src/app/api/webhooks/github/route-feedback.ts`
- Mention path: `apps/www/src/app/api/webhooks/github/handle-app-mention.ts`
- Check publishing: `apps/www/src/server-lib/github.ts`
- Upload primitives: `apps/www/src/server-lib/r2-file-upload.ts`

# Architecture Contract

## 1) Enrollment and boundaries

- Active-loop uniqueness via partial indexes for explicit active states.
- `stopped/done/terminated_*` excluded from active uniqueness.
- Enrollment is conflict-safe and returns existing loop.

### Multi-thread PR enrollment (user scoped)

- snapshot same-user siblings, classify, persist inclusion reason.
- one enrolled owner thread.
- post-enrollment new siblings default `excluded` unless audited revision.

### Routing and manual intents

- target-level routing with snapshot-first dispatch.
- enrolled targets bypass direct follow-up creators.
- manual intents only through wrapper, deduped by `(loopId,intentType,headSha,requestId|sourceEventId)`.

## 2) Single lock domain + FSM

- Use one loop lease domain for both state transitions and outbox execution (no second lock type).
- Lease contract: acquire/renew/expire/steal with epoch fencing and holder checks.
- Signal classes:
  - `head_bound` (SHA stale-checked)
  - `lifecycle_global` (`closed|merged|reopened`, bypass SHA staleness)

## 3) Ingestion, canonical causes, and reconciliation

### Atomic ingestion

single transaction:

1. delivery-claim CAS
2. target snapshot rows
3. dispatch rows
4. ingestion marker

### Delivery claim state machine + webhook responses

Claim outcomes:

- `claimed_new` -> process transaction, return `202 accepted`
- `already_completed` -> no-op, return `200 ok`
- `in_progress_fresh` -> no-op, return `202 accepted`
- `stale_stolen` -> new claimant continues, return `202 accepted`
- `invalid_signature` -> no mutation, return `401`

### Canonical cause identity matrix (versioned)

For non-daemon webhook triggers, cause identity domain includes `deliveryId` to preserve per-occurrence uniqueness while deduping retries.

- `daemon_terminal`: `eventId`
- `check_run.completed`: `deliveryId:check_run.id`
- `check_suite.completed`: `deliveryId:check_suite.id`
- `pull_request.synchronize`: `deliveryId:pull_request.id:head_sha`
- `pull_request.closed`: `deliveryId:pull_request.id:closed:merged|unmerged`
- `pull_request.reopened`: `deliveryId:pull_request.id:reopened`
- `pull_request.edited`: `deliveryId:pull_request.id:edited`
- `pull_request_review`: `deliveryId:review.id:state`
- `pull_request_review_comment`: `deliveryId:comment.id`
- `review-thread-poll-synthetic`: `loopId:poll_window_start:poll_window_end:poll_seq`

Inbox dedupe key: `(loopId, causeType, canonicalCauseId, signalHeadShaOrNull, causeIdentityVersion)`.

### Multi-worker reconciler CAS

- target rows claimed with CAS `pending->running` + claimant token + claim expiry.
- only claimant can finalize.
- expired claim can be stolen.
- per-target retry key `(deliveryId,targetClass,targetId)`.
- coordinator-target failures may affect loop; legacy-target failures never mutate loop state.

### Resolver hash canonicalization

- canonical JSON + resolver version in hash domain.

## 4) Daemon envelope migration

Envelope v2 required for enrolled loops:

- `payloadVersion,eventId,runId,seq,threadChatId,payload`.

Migration policy:

- server dual-read v1/v2 globally.
- enrolled loops accept daemon events only from v2-capable daemons.
- v1 daemon events for enrolled loops are rejected with deterministic error + operator/audit signal.

Ack contract:

- server ack only after durable cause+d edupe/inbox commit.
- ack echoes `{eventId,seq}`.
- daemon advances ack only on exact match.

## 5) Outbox supersession and must-stop

- FIFO by `transitionSeq`, idempotent `actionKey`, executed under loop lease owner.

### Canonical actionType -> supersessionGroup map

- `publish_status_comment` -> `publication_status`
- `publish_check_summary` -> `publication_status`
- `enqueue_fix_task` -> `fix_task_enqueue`
- `publish_video_link` -> `publication_video`
- `emit_telemetry` -> `telemetry`

Map is immutable versioned config; evaluator/tests must use same table.

### Validity predicate

- headSHA/loopVersion match, no superseded marker, no newer same-group transition.

### must-stop

On terminal must-stop failure (under same transition txn):

- transition loop to stopped reason
- cancel pending outbox rows `canceled_due_to_stop`
- freeze executor for loop

## 6) Gate semantics

### Deep/Carmack

- schema-validated outputs + stable finding ids.

### CI

Credential pinning:

- all CI policy/check evaluation must use GitHub App installation token only.
- persist `actorType=installation_app` in evaluation records.

Capability states:

- `supported`, `forbidden`, `unsupported`, `transient_error`.

Required-check precedence:

1. Rulesets
2. Branch protection
3. allowlist
4. no-required

Ruleset unavailable behavior deterministic by capability state.

Persist per eval:

- normalized identities, provenance, normalization/truth-table version, snapshot hash, actorType.

### Review-thread

- unresolved threads block; bounded pagination/retries; deterministic timeout stop.

## 7) Human feedback and overrides

- deterministic reopen predicates with parser version pinning.
- `done` invariant unchanged unless authorized override.
- immutable override audit rows.

## 8) Artifact security bound to existing access model

Storage:

- private-only.

Authorization bound to existing thread visibility/access primitives:

- `thread.owner` allow
- users granted thread shared access allow
- admins allow
- others deny

Signed URLs:

- short TTL + claims `(artifactId,viewerId,tokenVersion)`
- revocation by `tokenVersion` bump + denylist
- persist allow/deny decision reason codes + access audit events.

## 9) Config snapshots and retention

- immutable hash/versioned snapshots and decision references.
- indexed retention policy for delivery/target/inbox/outbox/audit/transition tables.

## 10) Guardrail evaluator precedence

Transactional evaluator before transitions/manual intents/reconciler/outbox enqueue.
Order:

1. killSwitch
2. terminal block
3. lease validity
4. cooldown
5. maxIterations
6. manual-intent matrix
7. transition rules

Denials return deterministic reason codes with audit.

# Implementation Phases

## Phase 0: measurable rollout/cutover

Shadow routing + feature flag.
Cutover SLO formula:

- parity metric = matched dispatch decisions / total eligible decisions, computed per `causeType x targetClass` bucket.
- denominator excludes invalid-signature and explicitly filtered non-enrolled-only events.
  Hard gates:
- parity >= 99.9% in every bucket for 7 consecutive days
- 0 critical invariant violations for same window
  Rollback:
- any P0 invariant breach or parity < 99.0% in any 1-hour rolling window.

## Phase 1: schema/invariants

- active unique indexes, sibling policy/revisions, lease tables, snapshot/dispatch, reconciler claim fields.

## Phase 2: coordinator core

- FSM + single lease domain.
- atomic ingestion + claim state machine.
- cause identity matrix.
- v2 daemon enforcement for enrolled loops.

## Phase 3: gates

- deep/carmack.
- CI actor pinning + capability states + normalization.
- review-thread evaluator.

## Phase 4: side effects/publication

- outbox supersession map + must-stop cancellation.
- secure artifact publication tied to thread visibility primitives.

## Phase 5: validation

- cause identity uniqueness across repeated closed/reopened/edited events.
- claim state machine and webhook response semantics.
- v1 rejection/v2 acceptance for enrolled loops.
- single-lock-domain deadlock/livelock tests.
- outbox supersession map invariants.
- artifact auth matrix + deny reason logging.
- parity metric bucket calculations and rollback triggers.

# Quick Commands

```bash
pnpm tsc-check
pnpm -C apps/www test
```

# Acceptance

1. Canonical cause identity is unique per event occurrence and retry-safe.
2. Delivery claim outcomes are deterministic with defined HTTP responses.
3. Enrolled loops require v2 daemon envelope semantics.
4. One lock domain governs transition and outbox execution ordering.
5. Supersession-group mapping is canonical, versioned, and test-validated.
6. CI evaluation is pinned to installation-app actor and deterministic capability states.
7. Artifact authorization uses existing thread visibility primitives with deny reason audits.
8. Rollout cutover is gated by explicit parity formula and rollback thresholds.
9. Post-enrollment sibling-thread behavior is deterministic.
10. Reliability matrix passes including concurrency and migration edge cases.

# References

- Checks API: https://docs.github.com/en/rest/checks/runs
- Review threads: https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
- Webhook headers: https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers
- Signature validation: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
