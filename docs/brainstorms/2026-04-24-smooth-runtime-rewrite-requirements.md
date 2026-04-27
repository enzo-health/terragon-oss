---
date: 2026-04-24
topic: smooth-runtime-rewrite
---

# Smooth Runtime Rewrite

## Problem Frame

Terragon has accumulated too many overlapping control planes. The delivery loop tried to make autonomous PR delivery reliable, but it now spreads workflow authority across request handlers, daemon callbacks, cron, delivery-loop stores, UI status models, GitHub projections, and retry jobs. At the same time, AG UI, assistant-ui, and `agent_event_log` moved chat streaming toward a cleaner event/projection model, while Codex app-server and Claude ACP now expose richer protocol-native runtime events.

The rewrite should strip the app back to the basic product that must feel excellent: start a coding task, stream the agent smoothly, preserve context and artifacts, support follow-ups, stop/retry, show status, and keep GitHub/sandbox integration useful. Autonomous delivery-loop orchestration, phase gates, review/CI promotion, and self-continuing PR workflows should be removed as first-class product behavior.

This is also a quality reset. The target architecture should make ownership obvious, keep runtime boundaries small, and add lint/type/test guardrails so the old failure modes cannot quietly return through scattered imports, duplicate state models, oversized components, unsafe casts, or hidden workflow side effects.

AG UI plus assistant-ui is a strategic stack choice for the long run, not a temporary migration detail. The rewrite should lean into that stack for the user-facing task surface while moving the major architecture cleanup into sandbox orchestration, daemon runtime supervision, provider adapters, runtime sessions, and canonical event ingestion.

Streaming, realtime updates, speed, and performance are core product requirements. The rewrite should optimize for immediate feedback, low-latency event delivery, fast first paint, predictable reconnect, efficient replay, and minimal client/server work per event.

## Current Shape

```text
User starts/follows up on a task
  -> thread / thread_chat
  -> agent_run_context
  -> daemon dispatch
  -> Codex app-server / Claude ACP / legacy adapters
  -> /api/daemon-event
  -> agent_event_log + compatibility DB messages + delivery-loop signals
  -> /api/ag-ui/[threadId]
  -> chat UI projections
```

Target shape:

```text
User action
  -> durable AgentRun aggregate
  -> RuntimeAdapter (Codex app-server, Claude ACP, legacy fallback)
  -> canonical AgentEvents
  -> agent_event_log
  -> projections: transcript, run status, artifacts, meta, GitHub summary
  -> one smooth task UI
```

`AgentRun` is a conceptual aggregate in this requirements doc, not a required new table name. Planning should decide whether the existing `agent_run_context` row plus `agent_event_log` is sufficient, or whether a renamed/new run table is worth the migration cost.

## Requirements

**Product Surface**

- R1. The primary app experience must be a smooth task chat with reliable streaming, artifact access, stop, retry, and follow-up submission.
- R2. The app must remove delivery-loop phases, gates, plan promotion, autonomous PR continuation, and delivery-loop progress UI as first-class user-facing behavior.
- R3. Follow-ups must remain simple and reliable: queued user messages should dispatch when the current run reaches a terminal state.
- R4. GitHub integration must remain useful as task context and PR/check summary, but GitHub PR creation/review/check progression must not drive a hidden workflow state machine.
- R5. The task UI must preserve the useful status users expect: booting, running, waiting for permission, stopped, failed, complete, PR/check summary, and sandbox availability.
- R6. The task UI should standardize on AG UI plus assistant-ui components for streaming, transcript/runtime presentation, and assistant interaction primitives where they fit cleanly.
- R7. Users must see realtime progress quickly: submitted messages, run start, streaming text, tool activity, permission prompts, artifact updates, and terminal state must appear without waiting for broad refetches.

**Runtime Architecture**

- R8. The strategic center must be Terragon's run control plane plus canonical event log, with AG UI as the presentation/event protocol layer, not the delivery loop and not any single provider process.
- R9. Codex app-server must become a first-class `RuntimeAdapter` behind the Terragon run/event contract, with explicit runtime session state for Codex thread/response resume data.
- R10. Claude Code must move toward ACP as its first-class runtime boundary, with legacy Claude stream-json kept only as a compatibility fallback until real ACP coverage is verified.
- R11. Provider-specific events from Codex app-server, Claude ACP, and legacy runtimes must normalize directly into canonical `AgentEvent`s and AG UI events instead of round-tripping through Claude-shaped `ClaudeMessage` compatibility objects.
- R12. Runtime auth, model/provider routing, billing proxy configuration, and sandbox credentials must be inventoried and moved only where they currently vary by provider/runtime; generic plugin registries and speculative capability negotiation are out of scope.
- R13. Sandbox and daemon architecture must be improved as the main cleanup target: daemon supervision, runtime process lifecycle, reconnect/retry behavior, sandbox auth, sandbox liveness, and provider adapter dispatch should each have clear ownership.
- R14. Daemon-to-app event delivery must support low-latency incremental flushes with backpressure, batching/coalescing where appropriate, and deterministic ordering per run/thread chat.

**Architecture and Code Quality Guardrails**

- R15. The rewrite must define explicit architecture boundaries for runtime adapters, event ingestion, durable persistence, AG UI mapping, projections, UI view models, provider auth/proxying, sandbox lifecycle, daemon supervision, and GitHub projection/context.
- R16. Cross-boundary imports must be linted so UI code cannot import runtime orchestration, provider adapters cannot import app UI/state, request handlers cannot own workflow progression, and shared packages cannot depend on app/server runtime code.
- R17. New or revised modules must have one owner and one reason to change; duplicated state machines, duplicate projection paths, and parallel compatibility paths must be marked temporary with deletion criteria.
- R18. Lint rules must block the bug classes that caused this rewrite: `any`, unsafe casts at runtime boundaries, barrel exports in new runtime code, oversized React components, cross-layer imports, unhandled discriminated-union cases, floating promises in server/runtime paths, and direct mutation of multiple client caches for one user action.
- R19. Type-level exhaustiveness must be required for canonical event kinds, AG UI event mappings, runtime adapter operations, task states, failure classes, and message/artifact part renderers.
- R20. Tests must cover behavior and invariants at the new boundaries: event ingestion idempotency, replay from durable storage, adapter parity, permission/retry state transitions, projection determinism, follow-up dispatch, and security policy enforcement.
- R21. CI must run the architecture/lint/type/test checks needed to fail closed; scripts and generated files can remain excluded only through explicit allowlists.

**Durable Data Model**

- R22. The minimum durable spine must be `thread`, `thread_chat`, `agent_run_context`, and `agent_event_log`.
- R23. `agent_event_log` must be the authority for runtime event replay and projection reconstruction, including typed terminal events for every runtime path before live broadcast; aggregate status fields may cache current state, but Redis, SSE, and broadcast are delivery channels only.
- R24. `thread_chat.messages` and DB message shapes may remain as compatibility projections during migration, but they must not be the hidden runtime authority in the end state.
- R25. Delivery-loop persistence should be removed after call sites are uncoupled: enrollment/UI first, then dispatch intent, then daemon-event workflow fencing, then workflow tables.
- R26. Sandbox liveness and hibernation tracking must remain separate from delivery-loop removal; active run tracking is still required to keep sandboxes alive correctly.

**Client State and UX**

- R27. Active task UI must read from one view model surface: shell, transcript, run status, artifacts, meta, and composer state.
- R28. React Query should provide snapshots/refetches; an event-derived client reducer should own live transcript and run updates, hydrated from snapshots and SSE-delivered canonical events.
- R29. Optimistic user-message echo must be local to the transcript/run reducer first, then reconcile from server events; prompt components must not mutate multiple caches.
- R30. The UI should collapse duplicate transcript paths so canonical event or snapshot input produces one assistant-ui-compatible message projection.
- R31. Artifact, diff, terminal, plan, image/audio/resource, and tool-progress rendering must remain available through one AG UI / assistant-ui projection path. The default rendering structure should be a single typed switch with co-located projection helpers; introduce a registry only if planning finds real independent extension consumers.
- R32. The active task page must minimize render churn during streaming by isolating high-frequency transcript/tool updates from stable shell, header, sidebar, artifact, and composer state.
- R33. Streaming UI updates must be incremental and stable: new chunks should not re-render the full transcript, reset scroll, collapse open panels, or block input responsiveness.

**Reliability**

- R34. Terminal run state must be durable and typed; generic agent errors should be compatibility fallbacks, not primary diagnosis.
- R35. Retries must be explicit recovery actions such as retry after compact, restart runtime, or ask for human intervention; raw blind `Continue` retries must not exist.
- R36. Large context, child/sub-agent output, and tool logs must use bounded summaries or artifact references so retries do not amplify prompt size.
- R37. Runtime streams must fail closed on malformed canonical events, impossible sequence order, or mismatched run/thread/chat IDs.
- R38. Unknown provider event types must be visible in telemetry and preserved only in a quarantined raw payload field with size limits, envelope validation, redaction, restricted projection by default, and an explicit promotion path before user-visible rendering.
- R39. Realtime delivery must degrade predictably: on disconnect, tab sleep, server restart, or Redis gap, the UI must replay from durable cursor and converge without duplicate or missing visible updates.

**Performance**

- R40. The rewrite must define latency budgets for first paint, submit-to-user-echo, run-start visibility, first assistant token, tool-progress visibility, terminal-state visibility, reconnect catch-up, and long-thread replay.
- R41. Event ingestion and projection must be efficient enough for long coding tasks and sub-agent-heavy runs without O(full transcript) work per event.
- R42. Initial task load must use snapshots, cursors, pagination, or projection checkpoints so long histories do not block first paint.
- R43. Large artifacts, terminal output, diffs, images, audio, and tool logs must stream or load by reference rather than being embedded in hot transcript payloads.
- R44. Performance regressions in streaming, replay, or active task render churn must be caught by targeted benchmark, integration, or budget tests in CI where practical.

**Migration**

- R45. The rewrite must be delivered as staged removals with compatibility shims named as temporary bridges.
- R46. No delivery-loop table or workflow store may be deleted until the app no longer depends on it for run identity, terminal fencing, UI status, or follow-up dispatch.
- R47. Existing tasks must continue to render and replay during the migration, even if their history was written through legacy DB message paths.
- R48. Each migration stage must test the boundary it changes, while a shared adapter/projection replay matrix must continuously cover Codex app-server, Claude ACP, and at least one legacy Claude path.
- R49. Planning must compare the full runtime rewrite against a smaller intervention that disables/dormants delivery-loop behavior plus cleans up projections, and explicitly show why the smaller intervention cannot meet the success criteria if that is the conclusion.

**Security and Trust Boundaries**

- R50. Runtime event ingestion must require run-scoped daemon/provider tokens bound to user/org, thread, thread chat, run, sandbox, and runtime; tokens must be short-lived or revocable on stop/archive/terminal state and checked before event normalization or persistence.
- R51. Runtime event ingestion must include replay protection through monotonic sequence, nonce, cursor, or equivalent idempotency enforcement before appending canonical events.
- R52. Provider proxy calls must enforce user/org entitlement, model allowlists, budget/rate limits, fixed upstream allowlists, no client-controlled upstream base URLs, no client-supplied provider credentials, and audit logs for provider/model/runtime decisions.
- R53. Sandbox credentials must be encrypted at rest, injected at runtime with least privilege, redacted before event-log persistence, and represented in canonical events only through opaque references.
- R54. Event replay and artifact endpoints must verify thread membership/org access and define retention, deletion, and export behavior for event-log rows and derived projections.

**GitHub and PR Surface**

- R55. The preserved GitHub surface must include visible PR link/number, branch, status, check summary, mergeability when known, and empty/no-PR state.
- R56. User-initiated GitHub actions may survive only when they are explicit commands, such as open PR, mark ready, retry checks, or ask the agent to fix failing checks; these actions must not advance hidden delivery-loop phases.
- R57. The rewrite must drop hidden PR workflow behavior: phase gates, autonomous review/CI promotion, self-continuing PR babysitting, and PR state as a workflow driver.

**Active Task UX Flow**

- R58. The active task flow must define allowed actions for booting, running, waiting for permission, stopped, failed, complete, and sandbox unavailable states.
- R59. Follow-up behavior must be explicit in each state: send immediately when idle/terminal, queue while running, remain queued or prompt for action while waiting for permission, and survive stop/retry unless the user clears it.
- R60. Permission prompts must define approve, deny, dismiss/leave-pending, disabled composer behavior, keyboard path, and resulting run/composer state.
- R61. Artifact access must define loading, partial streaming, unavailable, failed load, and success states without blocking transcript streaming.

**Recovery Rules**

- R62. Planning must produce a retry matrix mapping typed failure classes to visible user action, button label, confirmation requirement, context handling, and resulting run state.
- R63. Runtime recovery must prefer bounded, state-changing retries: compact then retry, restart runtime then retry, reconnect/replay, or ask the user for intervention.
- R64. Recovery must include a replay acceptance case where Redis and broadcast are unavailable and the UI reconstructs terminal state from durable storage.
- R65. Planning must produce an adapter operation matrix for stop, resume, restart, compact-and-retry, permission response, and human intervention across Codex app-server, Claude ACP, and legacy fallback, including UI behavior when an adapter cannot support an operation.

**Migration Planning Gates**

- R66. The first planning deliverable must be a delivery-loop keep/remove/replace map covering enrollment/UI, dispatch intent, daemon-event workflow fencing, retry jobs, follow-up dispatch, and workflow tables.
- R67. The first planning deliverable must include a provider parity matrix for text, thinking, tool args/progress/result, permission, terminal, diff, plan, image, audio, resource link, auto-approval review, meta, rate limits, and model routing.
- R68. The first planning deliverable must define the runtime session contract: provider, external session/thread ID, previous response ID, checkpoint pointer, hibernation validity, compaction invalidation behavior, and migration/backfill from current `thread_chat` fields.
- R69. The first planning deliverable must include a historical replay inventory using sampled production-like legacy threads, golden replay fixtures, and an explicit rule for histories that cannot be losslessly reconstructed.
- R70. The first planning deliverable must set replay performance bounds for long runs, sub-agent-heavy runs, and large tool streams, including when to use projection snapshots, pagination, compaction thresholds, or event summarization.
- R71. The first planning deliverable must define reconnect semantics: replay from cursor, duplicate suppression, multi-tab/multi-client catch-up, and terminal events that arrive while the client is disconnected.

## Success Criteria

- New and resumed tasks stream from one canonical event/replay path without split token/message/broadcast truth.
- A user can start a task, watch progress, open artifacts, stop, retry, and send follow-ups without delivery-loop concepts appearing in the UI.
- A user can follow up during and after a run, recover from failure, resume an old task, inspect artifacts, understand PR/check state, and stop/retry without ambiguous state or hidden workflow behavior.
- Codex app-server and Claude ACP both produce the same user-visible projection categories: transcript, tool progress, artifacts, meta/status, and terminal state.
- Delivery-loop enrollment, phase gates, autonomous continuation, and delivery-loop UI can be disabled with no breakage to normal task chat, follow-ups, sandbox lifecycle, or basic PR visibility.
- The active task page has one state model for live updates and avoids React Query/TanStack DB/optimistic cache choreography.
- Stale Redis/SSE/broadcast data cannot override fresher durable terminal run state.
- With Redis/broadcast unavailable, a refreshed task page can reconstruct transcript and terminal run status from durable storage.
- Long historical runs and sub-agent-heavy runs meet explicit replay latency bounds without loading every raw event into the first paint path.
- Duplicate or replayed live events do not create duplicate transcript/tool/artifact UI state across reconnects or multiple open clients.
- CI fails when new code violates the architecture boundaries, exhaustiveness rules, type safety requirements, or client-state ownership rules introduced by the rewrite.
- The codebase has fewer overlapping runtime/projection paths after each migration stage, with temporary compatibility bridges tracked by deletion criteria.

## Scope Boundaries

- This rewrite does not need to preserve autonomous PR delivery, phase promotion, review gates, CI gates, or delivery-loop babysitting.
- This rewrite should not delete basic GitHub context, PR linking, PR/check summaries, or user-initiated PR actions if they are still useful without workflow orchestration.
- This rewrite should not remove automations entirely; automations can create tasks or queue prompts, but they should not depend on delivery-loop workflow phases.
- This rewrite should not make Codex app-server the only runtime. Codex app-server and Claude ACP are strategic investments, but the app-owned run/event contract is the center.
- This rewrite should not require a full visual redesign before architecture cleanup; the UI change is simplification of state and surfaces, not a new product shell.

## Key Decisions

- Remove delivery loop as a vertical feature: The highest leverage simplification is deleting autonomous delivery orchestration rather than rebuilding it with more durable queues.
- Keep the run/event spine: `thread`, `thread_chat`, `agent_run_context`, and `agent_event_log` are the minimum useful model for smooth tasks, replay, auth, and sandbox correlation.
- Make events authoritative for runtime replay: `agent_event_log` should be the replay/projection source; aggregate fields can cache current status, but live transports are not truth.
- Treat provider runtimes as adapters: Codex app-server and Claude ACP should feed the same canonical events instead of leaking provider-specific lifecycle into the app.
- Make architecture enforceable: Good structure is not enough unless lint/type/test rules prevent cross-layer drift and unsafe shortcuts.
- Preserve explicit GitHub, drop workflow GitHub: PR/check information and user-initiated PR actions can remain, but should not advance hidden delivery-loop phases.
- Shrink client state by choosing one active-task view model: The smoother UX comes from removing state choreography, not from removing rich rendering.

## Alternatives Considered

1. Rebuild delivery-loop v3 completely.

   - Pros: preserves autonomous PR delivery ambitions and existing reliability work.
   - Cons: keeps the system centered on a large workflow engine the user explicitly wants to rip out.
   - Decision: reject as the main direction.

2. Make Codex app-server the whole product center.

   - Pros: focuses investment on the most strategic runtime.
   - Cons: would make Claude ACP and future providers second-class and repeat the provider-shaped plumbing problem.
   - Decision: invest heavily in Codex app-server, but behind Terragon's run/event contract.

3. Minimal smooth runtime with provider adapters.
   - Pros: removes the largest source of complexity while preserving the durable task primitives and future runtime optionality.
   - Cons: gives up autonomous delivery-loop product behavior unless rebuilt later as a separate feature.
   - Decision: recommended direction.

## Dependencies / Assumptions

- Existing AG-UI work has already established `agent_event_log` and `/api/ag-ui/[threadId]` as the practical replay/live-stream path.
- Existing Claude ACP implementation is real but still translated through compatibility message shapes; real ACP fixture coverage should be verified before legacy deletion.
- Existing Codex app-server integration is functional but still daemon-local and partly Claude-shaped; it needs durable runtime session ownership before it can become the smooth default.
- Existing delivery-loop tables may still protect run identity and terminal fencing, so removal must follow call-site uncoupling rather than schema deletion first.
- The user has chosen smooth runtime reliability and product simplicity over preserving autonomous delivery-loop behavior as currently designed. Planning should still inventory any user-facing PR behaviors that are worth preserving explicitly.

## Outstanding Questions

### Resolve Before Planning

- None. The remaining open items are planning deliverables rather than product decisions.

### Deferred to Planning

- [Affects R9/R68][Technical] What exact runtime session contract replaces `thread_chat.sessionId` and `thread_chat.codexPreviousResponseId`?
- [Affects R11/R67][Technical] Which canonical `AgentEvent` variants are missing for full Codex app-server and Claude ACP parity?
- [Affects R25/R66][Technical] Which current delivery-loop call sites still participate in daemon-event terminal fencing, run ID recovery, UI status, or follow-up dispatch?
- [Affects R48/R67][Needs research] Which real Claude ACP rich content events are emitted in production-like runs versus only supported by the protocol?
- [Affects R13-R19][Technical] Which architecture/lint rules can be enforced with existing tooling, and which need custom lint checks?

## Next Steps

-> /ce:plan for structured implementation planning.
