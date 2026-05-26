# Path to fully native AG-UI + assistant-ui

**Date:** 2026-05-25
**Status:** proposal for review
**Relationship to existing docs:** This is a _current-state overlay_ on the
plan of record (`2026-04-27-refactor-chat-layer-consolidated-plan.md`) and the
writes ADR (`2026-04-30-runtime-owns-writes-adr.md`). It does not replace their
phase definitions. It adds two things those docs under-specify: (1) an honest
done/partial/not-started status for each phase, and (2) a **message-identity
unification workstream** that is the root cause of the transcript-duplication
bug class and a hard prerequisite for collapsing the parallel reducers.

## What "fully native" means (exit criteria)

We are "fully AG-UI + assistant-ui native" when all of these hold:

1. **One identity per message, end to end.** A logical message keeps one id
   from daemon emit → persist → replay → hydration. No id-space crossings
   (`msg_<hex>` vs `baseEvent.eventId` vs `hydrate-N` vs `agent-N`).
2. **AG-UI event log is the sole transcript writer.** `thread_chat.messages`
   stops receiving runtime transcript writes; the `followUp()` path routes
   through the runtime's `append → POST` adapter.
3. **Every rich part is a native AG-UI event.** diff/plan/terminal/delegation/
   auto-approval-review/image/audio ride `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA`,
   not `terragon.data-part` CUSTOM events.
4. **The runtime owns the rendered transcript.** No parallel Terragon reducer
   folds the same event stream; rendering projects from runtime state only.
5. **The dedup/collapse band is deleted.** `collapseHydrationReplayTextDuplicates`
   and the coalescing fallback are gone because identity makes them unnecessary.
6. Documented permanent divergences remain exactly the four in the plan of
   record (TipTap composer, streamdown markdown, lifecycle queue, server-action
   writes-as-read-side). Nothing else stays custom.

## Current status (against the 9 phases)

| Phase | What it is                                                     | Status            | Evidence                                                                                                                                           |
| ----- | -------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Hardening: memoized runtime, error boundary, exact-pinned deps | **Landed**        | deps pinned exact (AGENTS.md); transient-error swallow shipped (#204)                                                                              |
| 1     | Native AG-UI event contract + render viability                 | **Partial**       | canonical events + mapper exist; rich parts still ride `terragon.data-part` CUSTOM, not `ACTIVITY_*`                                               |
| 2     | Switch transcript writes to AG-UI events                       | **In progress**   | governed by writes ADR; `POST = GET`, writes still flow through `followUp()` until ADR Wave 2                                                      |
| 3     | Tool registry + ActionBar primitives                           | **Landed**        | `TOOL_DISPATCH` table + typed `tool-registry.ts` (AGENTS.md invariant)                                                                             |
| 4     | Part renderer registry                                         | **Landed**        | `PART_REGISTRY` with compile-time exhaustiveness (AGENTS.md invariant)                                                                             |
| 5     | Runtime owns the rendered transcript                           | **Mostly landed** | transcript reads `useAuiState(state.thread.messages)`; `includeTranscriptMessages:false` on the view model                                         |
| 6     | Reducer collapse + legacy deletion                             | **Not started**   | `thread-view-model/reducer.ts` + `ag-ui-messages-reducer.ts` still exist; `collapseHydrationReplayTextDuplicates` is dead-for-render but undeleted |
| 7     | `chat-ui.tsx` extraction to ≤400 LOC                           | **Partial**       | still ~650+ LOC                                                                                                                                    |
| 8     | Reliability tests + AGENTS.md final                            | **Ongoing**       | replay integration harness exists; not yet the deletion gate                                                                                       |

Net: the _structure_ is largely native (Phases 0/3/4/5). The _contract_ gaps
(Phases 1/2/6) are what keep us non-native — and they share one root: identity.

## The missing workstream: identity unification (W-ID)

The transcript-duplication bug is an identity bug. A single Codex agent message
was emitted under two ids (delta stream `msg_<hex>` + canonical
`baseEvent.eventId`); both persisted and replayed; the runtime rendered both;
coalescing stacked them. The dedup reducer (`collapseHydrationReplayTextDuplicates`)
is a workaround for exactly this — and Phase 6 cannot delete it until identity
is unified, or duplicates return.

W-ID is the prerequisite that the existing plan folds implicitly into Phases
1/2/6 but never sequences on its own. It must lead.

| Step   | Scope                                                                                                                                                                                                                                                   | Status                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| W-ID.1 | Codex agent text: deltas are the single persisted representation under the Codex item id; suppress the redundant canonical `assistant-message`                                                                                                          | **Done** (this branch)      |
| W-ID.2 | Codex reasoning: same unification; thinking rode the server rich-part id path (`${envelopeV2.eventId}:msg:N` → `:thinking:N`) divorced from the reasoning delta item id. Now tagged + flushed; server skips the rich-part REASONING for tagged messages | **Done** (this branch)      |
| W-ID.3 | Claude path: delta `block:<index>` ids vs canonical `baseEvent.eventId` — apply the same single-representation rule                                                                                                                                     | Not started                 |
| W-ID.4 | Hydration id alignment: `dbMessagesToAgUiMessages` (`hydrate-N`) and `toUIMessages` (`agent-N`) must reuse the persisted event id, so history and live reconcile by identity                                                                            | Not started                 |
| W-ID.5 | Deletion gate: once W-ID.1–4 land and the replay harness proves no duplicates across reconnect/resume/active→idle, delete `collapseHydrationReplayTextDuplicates` and the coalescing dedup                                                              | Not started (gates Phase 6) |

## Critical path to native

```
W-ID.1 (done) ─► W-ID.2 ─► W-ID.3 ─► W-ID.4 ──► W-ID.5 ─┐
                                                         ├─► Phase 6 (collapse reducers, delete dead dedup)
Phase 1 rich-parts → ACTIVITY_* ────────────────────────┤
Phase 2 writes ADR Wave 2 (runtime owns writes) ────────┘
                                                         └─► Phase 8 (reliability gate + AGENTS.md final)
Phase 7 (chat-ui extraction) — parallel, independent
```

Sequencing rationale:

- **W-ID first.** It is cheap per-step, directly kills the live bug class, and
  unblocks the single highest-LOC deletion (Phase 6). Each step is independently
  shippable and verifiable on the replay harness.
- **Phase 1 rich-parts → ACTIVITY\_\*** can run in parallel with W-ID; it removes
  the last `CUSTOM` dependency for durable parts and is a precondition for
  "every rich part is native."
- **Phase 2 (writes ADR Wave 2)** proceeds on its own ADR cadence; it is the
  other half of "AG-UI is the sole writer."
- **Phase 6** is the convergence point — it can only start once W-ID.5 + Phases
  2 and 5 are green. It is where the parallel reducers and the dead dedup band
  actually get deleted.
- **Phase 8** ratifies: the replay harness becomes the mandatory pre-deletion
  gate, and AGENTS.md records the final invariants.
- **Phase 7** is orthogonal cleanup; schedule whenever.

## Immediate next steps (this branch / next)

1. Ship W-ID.1 (done) + the command-output-as-text fix (separate, already
   scoped: route `commandExecution/outputDelta` as tool progress, not `text`).
2. W-ID.2 (Codex reasoning identity) — same shape as W-ID.1, in the rich-part
   emission path rather than the canonical text path.
3. Stand up the replay-harness duplicate-detection assertion as a reusable gate
   (it is needed for every W-ID step and for Phase 6).

## Risks

- **Deleting the dedup band too early.** If `collapseHydrationReplayTextDuplicates`
  is removed before W-ID.4, any remaining id mismatch resurfaces as visible
  duplicates. Mitigation: W-ID.5 is explicitly gated on the harness.
- **ActivityMessage adoption (Phase 1) churn.** assistant-ui/AG-UI are pre-1.0;
  `ACTIVITY_*` shape may shift. Mitigation: keep deps exact-pinned (Phase 0) and
  gate on the harness.
- **Writes ADR and W-ID interleave.** Both touch the persist boundary. Mitigation:
  W-ID changes the daemon's _emit_ identity; the ADR changes the _write path_.
  Keep them in separate PRs with the harness green between each.

## Open question

Confirm whether the May-24 docs (`2026-05-24-001..004`) refine or supersede the
April-27 plan of record. AGENTS.md still names April-27 as authoritative; if the
May-24 set is newer intent, this overlay should point at those phase numbers
instead.
