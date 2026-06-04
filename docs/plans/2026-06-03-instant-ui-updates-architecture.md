# Instant UI Updates: Long-Term Architecture

> Status: Decision-ready. Audience: senior engineers who know the chat layer. Plan of record once approved. Supersedes ad-hoc deadlock-fix discussion.
>
> Validation: the file:line claims below were code-verified against the worktree on 2026-06-03. The crux holds — `isAgentWorking = isPrimaryChatLiveThreadStatus` and `'booting' ∈ PRIMARY_CHAT_LIVE_THREAD_STATUSES`, so the hoisted optimistic flip does open the stream. One correction was applied vs. the raw research output: `apps/www/vercel.json` exists (the draft claimed it did not) — see "How serverless connection cost is bounded." Produced by a multi-agent research workflow; 6 of 10 mapping/research sub-agents failed to return structured output, so external-citation depth is lighter than the in-repo grounding.

## Executive summary

Ship **Candidate 2: the Unified Optimistic Intent Seam**. Hoist the existing optimistic flip out of the legacy `handleSubmit` branch and into `routeComposerSubmit` so it fires on _both_ the `runtime.append` and fallback paths, before the transport call. That single move breaks the deadlock because the flip — not the transport branch — becomes what opens the resume stream. The win keeps `idle-finalized` (so idle threads pin zero SSE connections, the cost property Candidate 1 would have inverted), stays inside the pinned `@assistant-ui/react` 0.12.24 / `@assistant-ui/react-ag-ui` 0.0.26, and never revives the deleted dispatch tree. It carries two real costs that are not optional polish: a **rollback path that does not exist today** (without it a server rejection turns the freeze into a forever-spinner) and **double-render de-dup** of the user turn keyed on `clientSubmissionId`. We graft four hardening ideas from the other candidates — collapse the two parallel status fields (C4), terminal-event-driven tool-call finalization (C1), the messageSeq-only cursor guard (C4), and the swallowed-lookup metric (C1) — to close the stuck-state classes the bare fix would leave open.

## The problem & today's failure

### The gated-subscription deadlock

The live transcript subscription is assistant-ui's `unstable_resume` GET. Whether it opens is gated on a single client-derived boolean, `isAgentWorking`, through this chain:

```
threadViewModel.lifecycle.threadStatus   (chat-ui.tsx:404)
        │
        ▼  isAgentWorking() = isPrimaryChatLiveThreadStatus()
isAgentCurrentlyWorking                   (chat-ui.tsx:406-408)
        │
        ▼  prop: isAgentWorking
AssistantRuntimeSession                   (assistant-runtime-session.tsx:149)
        │
        ▼  resolveRuntimeResumePolicy()   (runtime-resume-policy.ts:20,30)
historyMode = isAgentWorking ? "active-resume" : "idle-finalized"
replayCursorAction = isAgentWorking ? "apply-history-last-seq" : "clear"
        │
        ▼  hydration adapter (assistant-history-hydration-adapter.ts:575)
unstable_resume = (mode === "active-resume")
        │
        ▼
resume GET opens  ⇔  isAgentWorking === true
```

On an **idle thread**, `isAgentWorking` is `false`, so the policy is `idle-finalized` and `unstable_resume` is `false`. No live GET ever opens. The only event that would flip `isAgentWorking` to `true` is `RUN_STARTED`, and `RUN_STARTED` can only arrive **over the GET that never opened**. The circle closes:

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
  isAgentWorking = false                               │
        │                                              │
        ▼  gates                                       │
  resume GET stays CLOSED                              │
        │                                              │
        ▼  so it never delivers                        │
  RUN_STARTED never arrives ───────────────────────────┘
        (the one event that would set isAgentWorking = true)
```

This is the textbook sync-engine footgun: a predicate gates the very subscription that is the only thing that updates the predicate. The UI freezes until a manual refresh, which re-hydrates from a fresh server snapshot whose status has caught up.

### The dual-submit-path gap

There were two submit callbacks. Only one carried the flip that escapes the deadlock.

| Path                                | Where                                                                                               | Optimistic flip?                                  | Writes DB?                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `submitFallback` (= `handleSubmit`) | `chat-prompt-box.tsx:104` calls `onOptimisticUserSubmit(...)` then `publish({type:'send-message'})` | **Yes** — sets `lifecycle.threadStatus='booting'` | Yes (legacy pipeline)                                                |
| `runtime.append`                    | `composer-submit-routing.ts:93-105` calls `threadRuntime.append()` and returns                      | **No**                                            | Yes (AG-UI POST → `dispatchFollowUpFromAppend` → `followUpInternal`) |

The runtime-owns-writes ADR routed the dominant path through `runtime.append`. That path returns at line 105 without ever invoking `submitFallback`, so the flip in `handleSubmit` never fires for it. `isAgentWorking` stays `false`, the policy stays `idle-finalized`, and the deadlock above engages. The legacy path still works precisely because it carries the flip; the new path inherited the bug by dropping it.

The flip is load-bearing because `'booting' ∈ PRIMARY_CHAT_LIVE_THREAD_STATUSES`. `applyOptimisticUserSubmit` (`optimistic-events.ts:77-83`) writes both `state.threadStatus` and `state.lifecycle.threadStatus = 'booting'` synchronously in the reducer, which makes `isAgentCurrentlyWorking` true on the same React commit — before any network round-trip.

## Current architecture

### Data flow (read + write)

```
 COMPOSER (TipTap in ComposerPrimitive.Root)
   │  submit
   ▼
 routeComposerSubmit            composer-submit-routing.ts
   │  runtime.append({role:'user', content, runConfig})
   ▼
 AG-UI HttpAgent  ── POST /api/ag-ui/[threadId] ──┐
   │                                              │
   │                                  handleAgUiPostCommand
   │                                  → dispatchFollowUpFromAppend
   │                                  → followUpInternal   (THE DB writer)
   │                                       │ waitUntil()
   │                                       ▼
   │                                  durable AG-UI event log (messageSeq)
   │                                       │
 daemon ── broadcast-before-persist ──►  Redis Stream  agUiStreamKey(threadChatId)
   │                                       │  XADD (capped 500)
   │  POST returns → GET(request,ctx)      │
   ▼                                       ▼
 SSE GET  ◄── captureStreamCursor → replay-by-seq → liveTail XREAD
   │
   ▼
 @assistant-ui/react-ag-ui  useAgUiRuntime  (message-state projection)
   │
   ▼
 native-thread.tsx  (ThreadPrimitive/MessagePrimitive + nauval leaves)
```

The server side is correct and well-tested: `captureStreamCursor` runs _before_ the DB replay query (at-least-once overlap), replay de-dupes against live-tail by event identity, and the POST is a thin command-then-stream shim that calls `GET(request, ctx)` to reuse all SSE machinery (`route.ts:625`).

### Three competing sources of truth

| #   | Source                                                                           | Owns                                     | Reconciles via                                    |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| 1   | **Durable AG-UI event log** (`getAgUiEventEnvelopesForThreadChat`, `messageSeq`) | Authoritative ordering + run terminality | — (it is the truth)                               |
| 2   | **assistant-ui message-state** (`useAgUiRuntime`)                                | The rendered transcript                  | History adapter load + `unstable_resume` SSE      |
| 3   | **`threadViewModelReducer`** (`lifecycle.threadStatus`, queued parts, meta)      | Status / working indicator / sidebar row | `snapshot.hydrated` + `server.refetch-reconciled` |

Sources 2 and 3 hydrate and reconcile independently. The deadlock lives in the **seam between 3 and 2**: source 3 derives `isAgentWorking`, which gates whether source 2 opens its feed. Within source 3 there is a second hazard — two parallel status fields (`state.threadStatus` for the sidebar row, `state.lifecycle.threadStatus` for the working indicator) kept in sync by convention, not by type (`reducer.ts:365`, `optimistic-events.ts:77-80` both write both).

## Design principles for instant updates

Derived from the sync-engine and serverless research, these are the rules the recommendation must satisfy.

1. **Optimistic local apply is the source of "instant," not stream speed.** The projection mutates synchronously before the network confirms; the stream reconciles later. The deadlock is fundamentally a _missing optimistic flip_, not a slow stream.

2. **Poke, don't gate.** A local mutation should _open_ the feed as a self-poke. Never gate "should I subscribe" solely on projection-derived state that only the subscription delivers.

3. **Server reconciliation always beats optimistic state.** The optimistic flip is a hint that opens the stream; the durable log's `thread.status_changed`/`RUN_*` events win. Therefore every optimistic flip must be **revertible** on rejection.

4. `messageSeq` **is the one true cursor.** Never fall back to wall-clock timestamps or the retired `chatSequence` on the resume path — parallel DB writes break timestamp linearity (a correctness bug, not a perf nit).

5. **Keep liveness out of the durable projection.** "Is this thread live right now" is presence metadata, not a projection question. This justifies keeping `idle-finalized`: idle threads must not pin SSE connections.

6. **Don't fix the deadlock by holding more streams open.** Under Fluid Compute, idle SSE costs ~$0 CPU but real provisioned-memory-time. Holding idle streams inverts the cost model and burns the 1,024-FD/instance limit. Fix at the activation edge instead.

7. **Reuse the existing transport; do not import a second sync engine.** Terragon already has the durable log + monotonic seq + resume-by-seq + idempotent commands. The gap is one optimistic transition, not a missing engine.

## Candidate architectures compared

| Name                                                     | Source of truth                                               | Instant-update mechanism                                              | Serverless cost                                                                                     | Migration effort                                                    | Key risk                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **C1: Always-Live Subscription + Terminal Finalization** | Durable AG-UI log (unchanged)                                 | Always `unstable_resume:true`; finalize on RUN_FINISHED/RUN_ERROR     | **Worse** — pins a stream per _idle_ mounted thread; viability hinges on a Vercel dashboard setting | Small code, big infra prereq                                        | Inverts the cost model the research warns against                     |
| **C2: Unified Optimistic Intent Seam** _(WINNER)_        | Durable AG-UI log; optimistic flip is a hint                  | Synchronous reducer flip → `booting` → `active-resume` → stream opens | **~Zero incremental** — preserves `idle-finalized`                                                  | Small core fix; rollback + de-dup are the real work                 | Rollback not implemented today → forever-spinner on rejection         |
| **C3: Client Store as Source of Truth**                  | `threadViewModelReducer` (becomes canonical for messages too) | Synchronous local apply; `useExternalStoreRuntime` re-projects        | Unchanged-to-better                                                                                 | **Heaviest** — rewrites transcript ownership, re-derives ~580 lines | Streaming smoothness + `convertMessage` fidelity break _all_ messages |
| **C4: Server-Authoritative Log + Pure Projection**       | Durable AG-UI log (formalized)                                | Optimistic echo + broadcast-before-persist                            | ~Zero incremental                                                                                   | Mostly formalization + one flip                                     | Barely a new architecture; re-describes C2                            |

## Recommended architecture

### Decision

Adopt **C2: the Unified Optimistic Intent Seam**. Hoist the optimistic intent above the routing fork so it fires unconditionally on the runtime and fallback branches (never the queue branch), before the transport call. Everything downstream — `booting → isAgentCurrentlyWorking → active-resume → unstable_resume → open-stream` — already runs in production on the fallback path; this makes the runtime path take the same road.

### Components

| Component                | File                                    | Change                                                                                          |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Submit router            | `composer-submit-routing.ts`            | New `optimisticSubmit` arg, fired once before the queue/runtime/fallback decision; not on queue |
| Prompt box               | `chat-prompt-box.tsx`                   | Remove the in-`handleSubmit` flip; pass it as `optimisticSubmit`                                |
| Optimistic reducer event | `optimistic-events.ts`, `reducer.ts`    | Stamp `clientSubmissionId` onto the optimistic message; add `optimistic.user-submit-rejected`   |
| Resume policy            | `runtime-resume-policy.ts`              | Unchanged contract; now correctly fed `isAgentWorking=true` on append                           |
| Runtime session          | `assistant-runtime-session.tsx`         | Wire a real rejection from `handleRuntimeError` back to the reducer revert                      |
| Transcript leaves        | `native-thread.tsx` + `components/ai/*` | **Untouched** — no dispatch tree revived                                                        |

### Data flow (recommended)

```
 COMPOSER submit
   │
   ▼  (1) SYNCHRONOUS, before any network call
 optimisticSubmit(userMessage, 'booting', clientSubmissionId)
   │        └─ applyOptimisticUserSubmit: dbMessages += msg
   │           lifecycle.threadStatus = 'booting'   (writes BOTH status fields)
   │           hasOptimisticUserSubmit = true
   ▼
 isAgentCurrentlyWorking = true   (same React commit — spinner shows instantly)
   │
   ├──────────────► resolveRuntimeResumePolicy → active-resume
   │                 → unstable_resume:true → resume stream opens
   │
   ▼  (2) transport, after the flip
 runtime.append(...)  ── POST ──► dispatchFollowUpFromAppend → followUpInternal
   │                                    │ writes durable log (messageSeq)
   │                                    ▼
 daemon broadcast-before-persist ──► Redis Stream ──► liveTail
   │                                    │
   ▼                                    ▼
 RUN_STARTED arrives  ──► applyAgUiEvent: lifecycle → 'working' (authoritative)
   │
   ▼  (3) reconcile
 server.refetch-reconciled (replace-transcript):
   clears hasOptimisticUserSubmit, adopts snapshot.lifecycle
   │
   ▼  ON REJECTION (archived / permission / credits / lock-held)
 optimistic.user-submit-rejected:
   restore prior lifecycle + threadStatus, drop optimistic msg by clientSubmissionId
```

### The instant-update mechanism

Two synchronous, pre-network mutations deliver the instant feel; neither depends on the stream being fast:

1. **Instant user message** — `applyOptimisticUserSubmit` pushes the message into `dbMessages`/`sidePanel.messages` in the reducer; the bubble renders on the next commit, before any POST resolves.

2. **Instant working indicator + stream open** — the same reducer call sets `lifecycle.threadStatus='booting'`, which flips `isAgentCurrentlyWorking` true on the same commit, driving `active-resume → unstable_resume:true` and opening the resume SSE before `RUN_STARTED`.

After that optimistic window the durable log + Redis Stream take over via the existing path: `captureStreamCursor` before replay, replay envelopes by `messageSeq`, then `XREAD` live-tail with adaptive backoff. Authoritative `RUN_STARTED`/`thread.status_changed` reconcile over the optimistic `booting`; `shouldPreserveLocalLifecycle` (`reducer.ts:147-149`) keeps a stale preserve-active-transcript snapshot from clobbering the optimistic status until `server.refetch-reconciled` lands.

### Reconnect / replay-by-seq

Reconnect is unchanged and reuses the production-tested active-resume path. At `maxDuration` the SSE 504s; EventSource auto-reconnects with a **cursored GET** (`Last-Event-Id`/`fromSeq`), which replays by `messageSeq` and never re-POSTs the append. The advisory lock keyed on `clientSubmissionId` (`withFollowUpSubmissionGuard`) makes any accidental re-dispatch a 409, so the optimistic message + the POST + any reconnect retry never double-write.

**Grafted from C4 (cheap insurance):** add a lint/test guard that forbids any timestamp or `chatSequence` fallback on the resume path and asserts `replayCursorAction='apply-history-last-seq'` on the reopened stream, so it resumes from the captured seq instead of re-replaying from zero. This keeps the one-true-cursor invariant honest as the new optimistic-flip path reopens streams.

### Tool-call finalization

**Grafted from C1 (closes a stuck-spinner class for live runs).** Today dangling tool-call spinners are finalized only on the client load-time `idle-finalized` branch (`assistant-history-hydration-adapter.ts:566`). The server _already_ emits the fix on terminal events: `finishUnresolvedHistoryToolCalls` pushes a synthetic `<toolCallId>:unresolved-result` tool message on **both** `RUN_FINISHED` and `RUN_ERROR` (`durable-history-builder.ts:150-160`), and `terminal-event-synthesizer.ts` reconstructs a terminal entry from durable run status when the live-tail missed the marker.

Drive client finalization off **"last event is terminal,"** not "client thinks the agent is idle," as a belt-and-suspenders pass that runs on any load whose last event is terminal. This makes finalization correct for live runs that die without a clean terminal, _without_ adopting C1's always-on subscription or its cost regression. Keep `idle-finalized` intact — this is additive.

### How serverless connection cost is bounded

The fix opens **no new idle streams.** It opens the resume stream only at the moment a real run is dispatched — exactly when a stream should be open. `resolveRuntimeResumePolicy` still returns `idle-finalized` for genuinely idle threads, so a user with 50 mounted-but-idle threads holds **zero** open streams. This is the decisive cost advantage over C1, which would hold 50.

Under Fluid Compute, the open stream blocks on `XREAD`, so idle live-tail costs ~$0 Active CPU; the real cost is provisioned memory for the in-flight request, amortized across in-function concurrency. Two companion settings (independent of the correctness fix, required before a 100% rollout):

- **Raise the SSE route's effective** `maxDuration`**.** `apps/www/vercel.json` already grants `maxDuration: 800` to `src/app/**/*`, but the AG-UI route overrides it back down with `export const maxDuration = 300` (`route.ts:63`), which takes precedence for that function in Next.js. Drop or raise that route-level export so the SSE route gets the 800s ceiling (cuts reconnect frequency ~2.7x). Separately, enable in-function concurrency (~10) at the Fluid-Compute/account level to amortize provisioned memory ~10x — concurrency is configured outside `vercel.json` and is not on today.
- Make **Upstash XREAD/XADD command volume** the primary scale SLO, watching the existing `xreadBackoffCount`/`xreadErrorCount` diagnostics. Cost scales with concurrent _active_ runs, not total mounted threads.

The one scenario that breaks the cost guarantee is a **self-poke against a thread whose run never starts** (reject-after-flip, or a `runId:''` that never materializes): the awaiting-first-run liveTail blocks until `maxDuration`. The rollback path below is therefore a _cost control_, not just correctness. Add a ~30s no-run timeout on the awaiting-first-run liveTail so a misfire self-closes fast.

### How it fits the PINNED assistant-ui without reviving the dispatch tree

The change lives entirely in Terragon-owned composer/reducer code plus the `isAgentWorking` input to `resolveRuntimeResumePolicy`. It does **not** touch `@assistant-ui/react` internals, does **not** need newer `resumeRun` semantics, and stays within pinned `0.12.24` / `0.0.26`. The live transcript keeps rendering via `native-thread.tsx` + vendored nauval leaves; nothing reintroduces `PART_REGISTRY`/`TOOL_DISPATCH`/`message-part.tsx`/`ChatMessage`. TipTap stays the composer slot; `runtime.append` remains the write entry point per the runtime-owns-writes ADR. The only assistant-ui surface touched is the documented, intended one: `unstable_resume` is driven by `historyMode`, driven by `isAgentWorking` — we feed that input correctly.

### Where C2 has real costs (be honest)

| Cost                                             | Reality                                                                                                                                                                                                                                                        | Grafted mitigation                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rollback does not exist**                      | A non-transient append rejection leaves `booting` forever; `shouldPreserveLocalLifecycle` actively shields the stale status; `server.refetch-reconciled` never fires because no run was created. Freeze becomes a _worse_ stuck-spinner.                       | New `optimistic.user-submit-rejected` event wired through `handleRuntimeError`, distinguishing transient (`isTransientRunLifecycleError`) from real rejections. **Mandatory before general rollout.**                                      |
| **Double-render of the user turn**               | The optimistic `dbMessages` bubble and assistant-ui's own `runtime.append` message can both render the same turn. The de-dup key the plan assumes (`clientSubmissionId`) is **not** on the optimistic path today — `applyOptimisticUserSubmit` attaches no id. | Build id-threading: stamp `clientSubmissionId` onto the optimistic message, suppress the optimistic bubble once the runtime turn with the same id is present. Shared infra for de-dup, stop+resend ordering, and delta-ordering stability. |
| **Two status fields stay coupled by convention** | Every new write path (rollback, resend-over-reconcile) is a fresh chance to diverge sidebar row from working indicator.                                                                                                                                        | **Grafted from C4:** a single internal reducer setter that writes `threadStatus` and `lifecycle.threadStatus` together, enforcing the invariant by construction. Land before shipping rollback.                                            |
| **Same-tick queue-vs-append misroute**           | `routeComposerSubmit` reads `isAgentWorking` from laggy committed React state; back-to-back same-tick submits read the stale value and both append, hitting the run-lock. Human double-enter is guarded by `isSubmittingRef`; automation is not.               | Route the queue-vs-append decision through a synchronous ref/reducer state updated by the optimistic dispatch.                                                                                                                             |

**Grafted from C1 (independent reliability fix):** harden the currently-swallowed `getAgentRunContextByRunId` failure path (`console.warn`, `continue`) into an observable metric, so a persistently failing run-context lookup that leaves a thread tailing instead of finalizing is visible rather than silent.

## Phased migration path

Each phase is independently shippable and reversible. **Honest sequencing note:** Phase 1 alone is _not_ safe for general traffic — without Phases 2-3 it double-renders every idle-thread follow-up and converts the freeze into a stuck-spinner on rejection. The shippable unit behind a per-user flag is Phases 1+2+3 together.

### Phase 0 — Regression guard (ships first, no behavior change)

- **Files:** `apps/www/test/integration/*`, `composer-submit-routing.test.ts`
- **Do:** Add an integration-harness replay test driving the real `/api/ag-ui` route in-process: idle thread → `runtime.append` follow-up → assert the resume stream opens and `isAgentCurrentlyWorking` flips **without a refresh**. Add a unit case asserting the optimistic flip fires on the runtime-append branch. Both FAIL on `main`, pinning the bug.
- **Verify:** Tests red on `main`, green after Phase 1. The bug is invisible to unit tests — it lives in the cross-module gate between `composer-submit-routing`, status derivation, and `resolveRuntimeResumePolicy`. This is the one artifact every candidate agrees must land first.

### Phase 1 — Core fix (hoist the intent above the fork)

- **Files:** `composer-submit-routing.ts`, `chat-prompt-box.tsx`, `chat-ui.tsx`
- **Do:** Add `optimisticSubmit` to `routeComposerSubmit`, invoked once, synchronously, before the queue/runtime/fallback decision — **not** on the queue branch. Remove the `onOptimisticUserSubmit` call inside `handleSubmit` and pass it as `optimisticSubmit` so it is not double-fired on the fallback path. Keep `clientSubmissionId` identical between the optimistic event and the transport.
- **Verify:** Phase 0 idle-thread test goes green; fallback path unchanged.

### Phase 2 — id-stamping (no transcript suppression needed)

- **Files:** `optimistic-events.ts`, `reducer.ts`, `types.ts`
- **Correction (verified during implementation):** the transcript renders **only** from the assistant-ui runtime (`native-thread.tsx` → `ThreadPrimitive.Messages`); it never reads `dbMessages`/`sidePanel.messages` (`chat-ui-layout.tsx:262` passes `sidePanel.messages` to the secondary panel only). So the optimistic `dbMessages` push does **not** double-render in the transcript — there is no bubble to suppress, and any `clientSubmissionId`-keyed suppression in `native-thread.tsx` would be dead code. Phase 2 is therefore id-stamping only.
- **Do:** Stamp `clientSubmissionId` onto the optimistic message (a clone, leaving the durable original untouched) and onto the `optimistic.user-submitted` event, so rollback can match the message by id when a snapshot rehydrate has replaced object identity. Do **not** gate or remove the optimistic `dbMessages` push (it feeds the side panel + artifact/lifecycle derivation and is load-bearing).
- **Verify:** reducer test asserts the clone carries the id and the original is unmutated. The real single-bubble/no-flash risk lives inside the pinned `@assistant-ui/react-ag-ui` merge-after-local-mutations reconciliation of the runtime's own optimistic append against the SSE replay — pin that with an in-process replayer harness assertion before cohort rollout (BLOCKING pre-enablement gate, not a code change here).

### Phase 3 — Rollback + status-field collapse (the honest hard part)

- **Files:** `reducer.ts`, `optimistic-events.ts`, `assistant-runtime-session.tsx`, `follow-up-command.ts`
- **Do:** Add `optimistic.user-submit-rejected` restoring prior `lifecycle`/`threadStatus` and removing the optimistic message by `clientSubmissionId`. Surface a real (non-transient) rejection synchronously to the client — the POST adapter currently fire-and-forgets via `waitUntil` and returns best-effort `runId`, so wire a non-2xx POST or in-band error event → `handleRuntimeError` → reducer revert. Wire **both** the throw path and the non-throw returns (`lock-held` error, `duplicate-submission` skipped). Collapse the two status fields into one internal setter (grafted from C4). Extend rollback to clear the optimistic flag from the **durable terminal status on reconnect**, not only from `server.refetch-reconciled` fired synchronously after submit.
- **Verify:** Rejected follow-up reverts to idle, no stuck spinner; multi-tab `lock-held` reverts the losing tab; reducer property test asserts the two status fields agree after every event.

### Phase 4 — Serverless tuning + reconnect hardening (independent)

- **Files:** `apps/www/src/app/api/ag-ui/[threadId]/route.ts` (drop the `export const maxDuration = 300` override; `apps/www/vercel.json` already grants 800), `apps/www/test/integration/*`
- **Do:** Remove the route-level `maxDuration = 300` override so the SSE route inherits the 800s ceiling from `vercel.json`; enable in-function concurrency ~10 at the Fluid-Compute level; verify file-descriptor headroom under a load test of N concurrent active streams + Redis sockets. Add a ~30s no-run timeout on the awaiting-first-run liveTail. Add an explicit timeout-reconnect test asserting a 504 reconnect resumes via GET/cursor and does **not** re-dispatch the follow-up.
- **Verify:** Load test holds under 1,024-FD/instance cap; reconnect test green; Upstash command volume observed on a traffic fraction via the per-user flag before 100%.

## Risks & mitigations

Built from the adversarial verification (reconnect/replay, concurrency, serverless lenses).

| Scenario                                                                                                                                                                                                                                      | Breaks?            | Severity | Mitigation                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimistic flip opens a **second stream** while the POST already returns one (two concurrent live-tails of the same run; transcript dedup lives inside pinned `@assistant-ui/react-ag-ui`)                                                    | Yes                | High     | Keep `replayCursorAction='clear'` on the local-mutation path so no remount/second-GET fires; let `RUN_STARTED` from the POST stream own status. Phase-0 assertion: exactly one stream connection per run, agent text not duplicated |
| **Rollback missing** → forever-spinner on rejection (archived / permission / credits / `lock-held`)                                                                                                                                           | Yes                | High     | Phase 3 `optimistic.user-submit-rejected`; surface non-transient rejection synchronously. Mandatory before general rollout                                                                                                          |
| **Double-render** of the user turn (optimistic bubble + `runtime.append` message; no `clientSubmissionId` on the optimistic path today)                                                                                                       | Yes                | High     | Phase 2 id-threading; suppress optimistic bubble by `clientSubmissionId`                                                                                                                                                            |
| **Self-poke against a thread that never runs** pins a stream to `maxDuration` (cost-guarantee break)                                                                                                                                          | Yes                | High     | Phase 3 rollback closes it on rejection; ~30s no-run timeout on awaiting-first-run liveTail; harden swallowed `getAgentRunContextByRunId` into a metric                                                                             |
| **Missed-terminal-on-reconnect** (run finished while backgrounded; terminal evicted past the 500 cap) leaves a stuck spinner                                                                                                                  | Yes                | High     | Make the resume GET's terminal synthesizer authoritative for clearing the optimistic flag; call `reconcileActiveChatFromServer` on `visibilitychange` and every (re)connect                                                         |
| **Cursored resume starts mid-run without RUN_STARTED** (`route.ts:513` skips the RUN_STARTED-first contract when `replayCursorSeq !== null`); working indicator/cancel wrong                                                                  | Yes                | Medium   | Prefer the POST stream (non-cursored Path A) as the run's authoritative stream; ensure resume framing synthesizes RUN_STARTED for the cursored GET too. Test `lastSeq` captured right after a racing RUN_STARTED                    |
| **Stale terminal at boundary** re-emitted (`replayQueryAfterSeq` off-by-one when `projectionIndex` set) prematurely closes the new run                                                                                                        | Yes                | Medium   | Pin local-mutation path to `replayCursorAction='clear'`; test cursor landing exactly on a terminal event does not re-emit it                                                                                                        |
| **Multi-tab simultaneous send** — both flip locally, second loses the run-lock (`lock-held`); losing tab shows phantom message + spinner                                                                                                      | Yes                | Medium   | Same rollback path; make `lock-held` trigger an immediate reconcile in the losing tab                                                                                                                                               |
| **Stop + resend race** — in-flight stop reconcile arrives after resend and clobbers the resend's optimistic state                                                                                                                             | Yes                | Medium   | Tag each optimistic submit with a local sequence number; refuse a reconcile downgrade to idle if a newer optimistic submit is pending                                                                                               |
| **Two status fields diverge** under the new rollback write path                                                                                                                                                                               | Yes                | Low      | Single internal reducer setter writes both atomically (grafted from C4); property test asserts agreement                                                                                                                            |
| **`clientSubmissionId` covers the write but not the optimistic message identity** → user turn shown twice on history re-hydration before reconcile                                                                                            | Yes                | Medium   | Stamp a stable client id derived from `clientSubmissionId`; propagate through `followUpInternal` to the durable message; de-dup by that id                                                                                          |
| **In-function concurrency not configured**, and the route-level `maxDuration = 300` override (`route.ts:63`) caps the SSE route below the 800 already granted in `apps/www/vercel.json`; fix converts a free bug into a paid feature at scale | Yes                | Medium   | Phase 4: drop the route-level 300 override, enable in-function concurrency ~10, before scale rollout; FD-headroom load test                                                                                                         |
| **Reconnect storm** from the 300s cap multiplies replay-by-seq DB reads                                                                                                                                                                       | Partial            | Medium   | `maxDuration` 800 cuts frequency ~2.7x; EventSource native backoff de-synchronizes; watch `getAgUiEventEnvelopesForThreadChat(afterSeq)` p99                                                                                        |
| **Same-tick queue-vs-append misroute** (laggy `isAgentWorking` from committed React state)                                                                                                                                                    | Yes (programmatic) | Medium   | Route the decision through a synchronous ref/reducer state; `isSubmittingRef` already guards human double-enter                                                                                                                     |
| **`idle-finalized` regressed by a future "simplify to always-resume"** re-inverts the cost model at scale                                                                                                                                     | Hypothetical       | High     | Lock in with a test asserting an idle thread with no recent submit holds no open stream; never collapse `idle-finalized` into always-resume                                                                                         |

**Residual unknowns the harness must pin, not reasoning:** transcript-level dedup of two overlapping streams of the same run lives inside the pinned `@assistant-ui/react-ag-ui` 0.0.26 package, which is not Terragon-owned and cannot be patched without violating the exact-pin invariant. Pin it by an integration-harness replay assertion, not by reading library internals.

## Open questions for the team

- Should the local-mutation path keep `replayCursorAction='clear'` (single stream, status-only flip) or open a cursored resume GET? The reconnect-correctness analysis prefers consuming the POST's own SSE response and suppressing a second GET. Which becomes the contract?
- How should two genuinely-distinct user turns sent near-simultaneously across tabs behave — queue the second, reject with a toast, or accept both? This is a product question the `lock-held` rollback exposes.
- Do we surface append rejection as a non-2xx POST status or an in-band SSE error event? The POST adapter currently fire-and-forgets via `waitUntil`; both options need a new client-visible channel.
- Is enabling in-function concurrency ~10 and `maxDuration` 800 approved on the current Vercel plan, and does the FD load test confirm headroom at the target concurrent-stream count?
- Should we pull C4's status-field collapse forward as a prerequisite of Phase 1 (rather than Phase 3), given every new optimistic write path widens the split-brain surface until it lands?
- Is the ~30s no-run timeout on the awaiting-first-run liveTail the right bound, or should it track the daemon dispatch ack latency?

## Appendix — key files

| File                                                                      | Role                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/www/src/components/promptbox/composer-submit-routing.ts`            | The routing fork; hoist `optimisticSubmit` above it                                                   |
| `apps/www/src/components/chat/chat-prompt-box.tsx`                        | Holds the legacy flip in `handleSubmit:104`; pass as `optimisticSubmit`                               |
| `apps/www/src/components/chat/thread-view-model/optimistic-events.ts`     | `applyOptimisticUserSubmit` writes both status fields; add rejection + `clientSubmissionId`           |
| `apps/www/src/components/chat/thread-view-model/reducer.ts`               | Status reconciliation; `shouldPreserveLocalLifecycle:147-149`; add single status setter               |
| `apps/www/src/components/chat/chat-ui.tsx`                                | Derives `isAgentCurrentlyWorking:404-408`; wires `onOptimisticUserSubmit`                             |
| `apps/www/src/components/chat/assistant-ui/runtime-resume-policy.ts`      | Maps `isAgentWorking`→`historyMode`/`replayCursorAction`/`unstable_resume`                            |
| `apps/www/src/components/chat/assistant-ui/assistant-runtime-session.tsx` | `handleRuntimeError:224-245`; wire rejection→reducer revert here                                      |
| `apps/www/src/components/chat/assistant-history-hydration-adapter.ts`     | `finishUnresolvedToolCalls` gated on `idle-finalized:566`; `unstable_resume:575`                      |
| `apps/www/src/server-lib/follow-up-command.ts`                            | `dispatchFollowUpFromAppend` returns best-effort `runId:''`; `lock-held`/`duplicate` returns          |
| `apps/www/src/server-lib/ag-ui/durable-history-builder.ts`                | Server-side `:unresolved-result` finalization on RUN_FINISHED/RUN_ERROR `:150-160`                    |
| `apps/www/src/server-lib/ag-ui/terminal-event-synthesizer.ts`             | Reconstructs terminal from durable run status when live-tail missed it                                |
| `apps/www/src/app/api/ag-ui/[threadId]/route.ts`                          | SSE GET + POST shim; POST `return GET(...):625`; `maxDuration=300:63`; RUN_STARTED-first guard `:513` |
| `apps/www/test/integration/`                                              | Replay harness; the deadlock regression test lands here first                                         |
| `packages/shared/src/model/thread-lifecycle-policy.ts`                    | `isPrimaryChatLiveThreadStatus`; `'booting'` ∈ `PRIMARY_CHAT_LIVE_THREAD_STATUSES`                    |
