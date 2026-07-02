# Agent Architecture Redesign v2 — delete, simplify, lean on AG-UI

**Date:** 2026-07-01 (v2, supersedes the same-day v1)
**Status:** proposal for review
**Method:** nine sub-agent audits of the live code (transport, client runtime, server orchestration, plan docs, www deletion ledger, daemon deletion ledger, installed-library capabilities, token-to-pixel latency, durability failure modes). Every number below is code-derived with file:line evidence in the audit summaries.
**Goals (in order):** delete code · simplify abstractions · rely on AG-UI · durable and reliable · super fast streaming · native feel.

## 0. Corrections to the written record

The audits found the docs lagging the code. Fix these first so nobody plans against ghosts:

| Stale claim                                                                 | Reality                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AGENTS.md / plan docs: dispatch-tree deletion "deferred, ~25 entanglements" | Physically deleted in PR #246 (net −14k LOC). `ag-ui-messages-reducer.ts` and `collapseHydrationReplayTextDuplicates` are also already gone.                                                                                                                                                                |
| AGENTS.md: composer "is being wrapped in `ComposerPrimitive.Root`"          | `ComposerPrimitive` appears nowhere in the tree. Aspirational.                                                                                                                                                                                                                                              |
| MEMORY/older docs: "broadcast-before-persist"                               | The route is **persist-then-publish**: ~7 serial Postgres round-trips before the Redis XADD (`ag-ui-publisher.ts:484`).                                                                                                                                                                                     |
| "ACTIVITY\_\* adoption is blocked on library support"                       | `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` are native in the pinned `@ag-ui/core@0.0.52` and already consumed via a sidecar.                                                                                                                                                                                      |
| "`@assistant-ui/react-ag-ui` is pinned"                                     | It is pinned **and locally patched** (`patches/@assistant-ui__react-ag-ui@0.0.26.patch`) — a fork of `AgUiThreadRuntimeCore`+`RunAggregator` adding `externalMessagesStrategy`, `historyLoadKey`, `waitForInitialLoad`, `targetMessageId`. The biggest upgrade liability in the stack; document it as such. |

## 1. The two structural splits (root of the wedge-class)

Everything that has ever wedged a run or shown a wrong stop button traces to two seams:

1. **`thread_chat.status` is written independently of `agent_run_context.status`.** Different owners, non-atomic writes. Eight mechanisms can declare a run over; only four write the DB, and three real disagreement windows exist (sweep-vs-daemon wrong reason; stop-vs-natural-completion split; stalled-tasks orphaning run contexts forever). The client's 15s optimistic TTL, the footer freshness timer, the duplicate terminal synthesizer, and half the deadline sweep exist only to paper over this split.
2. **The daemon's outbound buffer is memory-only.** A daemon crash permanently loses every un-acked event, and every daemon-side failure (crash, OOM, hibernation, partition) collapses into the same detector: `updatedAt` staleness, ~15 minutes to visible failure. There is also no fetch timeout and a **global** flush mutex, so one hung POST freezes token streaming for every thread in the sandbox.

The fix for #1 is a deletion, not an addition: **make `thread_chat.status` a projection of the run-context terminal fence, written in the same transaction.** The fix for #2 is the one place we add code: a small append-only disk journal (append → POST → drop-on-ack → replay-on-restart), which demotes the deadline sweep to a true backstop.

## 2. Target architecture (unchanged thesis, now with evidence)

**The canonical AG-UI event stream is the only representation of a turn. Everything else is a projection.**

```
provider binary (claude-acp / codex-ws;  gemini via ACP when sandbox-agent supports it)
        ▼  normalize ONCE, mint identity ONCE, journal to disk
DAEMON  ──► canonical AG-UI events (deltas included, same ids) + ThreadMetaEvents
        ▼
SERVER ingest = typed stages: authenticate → fence → project → persist∥publish → transition
        ├── agent_event_log  (durable, protocol-valid AT WRITE TIME)
        ├── thread_chat.status = DERIVED from run-context fence (same tx)
        ├── DBMessage        = read-model projection (prompt builder, redo/fork, queue dedupe)
        └── Redis live-tail  = cache; XADD decoupled from the persist tx
        ▼
CLIENT  assistant-ui runtime = the only message store; optimistic overlay = the only write layer
```

Supporting facts from the library audit: the seq-cursor replay stack **must stay custom** (HttpAgent discards SSE `id:`/`retry:` fields — no native resume), the `ThreadHistoryAdapter` is the intended hydration seam and is used correctly, tool parts have exactly two text channels (the Codex stdout→RESULT routing is right), and typed error codes are already available via `AgentSubscriber.onRunErrorEvent` — no fork change needed.

## 3. Deletion ledger (quantified, sequenced)

Total identified: **~6,300–7,400 LOC net deletion**, in dependency order.

### Tier 0 — delete now (zero/low risk, ~1,000 LOC)

| What                                                                                                           | LOC  | Condition                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| `isDeltaStreamedAssistantMessage` (`shared.ts:454`) — zero consumers                                           | 16   | none — orphaned today                                                             |
| amp + opencode legacy stream-json commands + builders                                                          | ~485 | ACP already serves both; remove the `enableAcpTransport===false` escape           |
| `stopStalledThreads` terminality in the hourly cron (keep booting-requeue)                                     | ~100 | strict time-superset of the 15-min sweep; also fixes the orphaned-run-context bug |
| duplicate terminal synthesizer (`terminal-event-synthesizer.ts` vs `reconcileActiveRunFromDurable`) — keep one | ~150 | pick the live-tail copy                                                           |
| `pendingClientSubmissionIdRef` (`chat-ui.tsx:293`) — flagged in-code as a leftover                             | ~30  | reducer already projects `pendingClientSubmissionId`                              |
| stale doc/AGENTS.md corrections (§0)                                                                           | —    | with the same PR                                                                  |

### Tier 1 — after small refactors (~800 LOC)

| What                                                                                                               | LOC                 | Unblocking work                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `toUIMessages.ts` + `tool-part-projection.ts`                                                                      | ~510                | re-source `extractThreadLifecycleMessages` and `getArtifactDescriptors` off `UIPart[]` (their only two consumers) |
| coexistence-flag layer (`_codexItemId`, `_claudeStreamedBlockIndices`, `filterCanonicalEventsForDeltaCoexistence`) | ~90–260 incl. tests | deltas unified into canonical events under one identity (K1a)                                                     |
| client optimistic-latch TTL + footer freshness authority role                                                      | ~100                | derived `thread_chat.status` (§1 fix) makes them cosmetic                                                         |

### Tier 2 — the big one: legacy `messages[]` wire channel (~2,500 LOC)

Whole files die: `toDBMessage.ts` (589), `daemon-event/router.ts` (590), `message-parser.ts` (290), `lifecycle-manager.ts` (227), `daemon-event/types.ts` (179), `recovery/auto-compact.ts` (147), `recovery/oauth-retry.ts` (127), `linear-activity-emitter.ts` (63), `handle-daemon-event.ts` (47), plus ~210–290 partial in `route.ts`/`event-commit.ts`.

**Gate:** recovery parity in the canonical model (K2 below). The recovery path — rate-limit re-queue, OAuth retry, auto-compact — currently lives in this channel and dies with it. `DBMessage` becomes a projection folded from the canonical log; the audit confirmed `DBAgentMessage`/`DBToolCall`/`DBToolResult` have **no live non-render consumers**, so the projection only needs to serve user/system/meta reads (prompt builder, queue dedupe, redo/fork, thread naming).

### Tier 3 — read-time repair band (~400–600 LOC)

Once the ingest pipeline enforces protocol validity at write time (per-run state machine: START/CONTENT/END pairing, one terminal, monotonic seq — ship in observe mode first), delete the per-connection repair machinery: `repairReplayTextMessageLifecycles`, `repairDelayedRunStartedOrdering`, `dropDuplicateRunStarted`, `dropEventsAfterTerminalUntilNextRun`, and the 6-level dedupe cascade in `ag-ui-replay-planner.ts`. Replay becomes a dumb cursor read.

### Tier 4 — blocked externally (~1,770 LOC)

Full legacy stream-json removal (`spawnAgentProcess`, `runClaudeCodeCommand`, `runCodexCommand`, `runGeminiCommand`, `claude.ts` parser, `gemini.ts`) waits on one thing: **a Gemini adapter in `sandbox-agent`** (closed-source Anthropic binary). It is the sole agent ACP can't serve. Raise this upstream; it unblocks the last legacy transport and makes ACP + codex-ws the only two transports.

## 4. Speed plan (token-to-pixel)

The client is already fast (16ms coalescing seam, contained re-renders, memoized markdown prefix). All wins are daemon/server, ranked by impact:

1. **Decouple the live-tail XADD from the persist transaction** (`ag-ui-publisher.ts:484`). Every token currently pays ~7 serial Postgres RTs before broadcast. Deltas are DB-recoverable by seq, so publish in parallel with (or before) the tx. This is the true "broadcast-before-persist" the architecture always claimed.
2. **Per-thread flush queues + fetch timeout in the daemon** (`daemon.ts:4470`, `runtime.ts:474`). Kills cross-thread head-of-line blocking; an AbortController on `serverPost` stops one hung POST from freezing all streams.
3. **Shared per-streamKey subscriber on the SSE route** (`route.ts:147-208`). N viewers currently run N independent Upstash XREAD loops plus a Postgres liveness read every 2 empty polls. One process-level subscriber fanning out to local controllers cuts Upstash and Postgres load ~N×.
4. **Kill the cold-open double-read**: idle resume policy clears `lastSeq` (`runtime-resume-policy.ts:45`), forcing the SSE open to re-scan the whole run from Postgres after the history endpoint already read it. Seed `fromSeq=lastSeq` instead.
5. **History projection 6→2 round-trips** (`thread-history-projector.ts:41-78`): derive runId from the envelope rows in memory, parallelize the liveness pair; fold the advisory-lock + `MAX(seq)` into one statement.

Also: batch the per-publish `EXPIRE` into the XADD pipeline, and drop the Codex serialize→re-parse double JSON hop (`daemon.ts:1839`).

## 5. Durability: the minimal mechanism set

Keep five mechanisms; delete the rest (they exist to compensate for the two splits):

1. Run-context terminal CAS as the **sole** terminal writer, with `thread_chat.status` derived in the same tx.
2. The 2-min/15-min deadline sweep, reduced to fencing the run-context only — the single backstop.
3. A daemon disk journal for the outbound buffer — closes the only unrecoverable-loss window.
4. One **durable DB idempotency key** on follow-up append (server-generated, persisted), replacing the four partial Redis guards (5s run-lock, 24h submission key, text-fingerprint dedupe ×3). Also stop swallowing `waitUntil` dispatch failures — today a throw after the 200 is a silently lost follow-up.
5. Persist-then-replay-from-seq for the durable log (already correct — every Redis failure is non-lossy today; keep it).

Explicitly demoted to cosmetic: client optimistic TTL, footer freshness. Explicitly deleted: stalled-tasks terminality, the duplicate synthesizer, the layered Redis follow-up guards.

## 6. Leaning further into AG-UI (native feel)

- **Rich parts → `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA`** — native in the pinned core, no version bump needed. Move diff/plan/terminal/delegation off `terragon.data-part` CUSTOM; the sidecar already consumes ACTIVITY events, so this converges the two paths.
- **Typed errors via `onRunErrorEvent`** — the subscriber callback already carries `RunErrorEvent.code`; replace the defensive `(error as {code}).code` cast and the `/Run already in progress/i` regex classification. Pairs with the roadmap's `ChatErrorEvent` work: daemon terminal → `RUN_ERROR.code` aligned to `ThreadErrorType` → exhaustive `ChatError` switch with a real `never` check.
- **Close the two `followUp()` bypasses** (`git-diff-comment-widget.tsx:77`, `use-thread-intent-handler.ts:37`) onto `runtime.append` — after which the append path's idempotency guard covers all submissions and the `send-message` intent variant dies.
- **Own the fork deliberately.** The react-ag-ui patch is real architecture; give it a README in `patches/` stating what it adds and the upgrade procedure, and add a harness assertion that fails loudly if a bump drops the patched options. Fragile spot to watch: `runtime-error-classification.ts:19-25` matches `verifyEvents` throw strings — pin those strings in a test.
- **Keep custom (verified necessary):** seq-cursor replay stack, TipTap composer slot, streamdown, 16ms coalescing, `runtime-resume-policy`.

## 7. Execution waves

```
Wave 0  Tier-0 deletions + §0 doc corrections + latency #2 (daemon timeout/queues)     [independent, ship now]
Wave 1  Derived thread_chat.status (§1 fix) + latency #1 (XADD decouple) + #4 (fromSeq seed)
Wave 2  K2 typed recoverable terminals in canonical model  →  unlocks Tier-2
Wave 3  K1a deltas-as-canonical (one identity)  →  Tier-1 coexistence deletion; W-ID.3/4/5 fall out
Wave 4a REORDERED (2026-07-02): rich-part canonical carrier FIRST — the messages[] channel is
        the sole persister of the acp-*/codex-* rich-part surface (plan/diff/terminal/image/
        audio/resource-link/auto-approval-review/codex-error) + meta + permission; the canonical
        builder emits nothing for those types, so the Tier-2 equality gate is unconstructable
        until they have a full-fidelity canonical carrier. This was originally Wave 6's
        ACTIVITY_* item; it must precede the deletion, not follow it.
Wave 4b Tier-2: delete messages[] channel; DBMessage becomes a projection (harness equality gate).
        The `|| messagesIndicateRecoverableFailure` fallback also dies here, NOT earlier — no
        deployed daemon stamps the typed recoverable field until this branch ships.
Wave 5  Write-time validity (observe → enforce)  →  Tier-3: delete the repair band.
        LANDED: run-protocol-validator.ts (per-run state machine mirroring the read-time
        band) + harness gate (write-time-protocol-validity.test.ts, zero violations across
        recorded corpus), default OBSERVE. EXIT CRITERION for deleting the repair band:
        a production observe-mode soak reporting ZERO would-be repairs (the
        [agui-write-validation] diagnostic) sustained across a full daemon-version window,
        AND enforce mode shipped as the default. Until both hold, the repair band stays.
Wave 6  typed errors end-to-end + close followUp() bypasses (ACTIVITY_* item moved to 4a)
Ext     Upstream ask: gemini in sandbox-agent  →  Tier-4 legacy transport deletion
```

Rules: one wave at a time on the optimistic-submit/resume seam; every wave gates on the replay integration harness; pins and the patch stay exact; daemon disk journal (durability #3) can land any time — it's additive and independent.

## 8. Risks

- **Tier-2 equality gate**: DBMessage-from-canonical must match DBMessage-from-`messages[]` across the recorded corpus before the swap; budget recorder time to widen the corpus (especially recovery scenarios: rate-limit, OAuth-revoked, auto-compact).
- **Write-time validation** may reject what read-time repair tolerated — observe mode first, count would-be repairs, then enforce.
- **XADD-before-persist** re-opens the ordering question the route solved with deferred terminal persists; keep terminals on the post-persist path (only content deltas go early).
- **Derived status** touches the same seam as the recently landed run-lifecycle work (W1–W6) — land behind the existing flag pattern with the harness as the gate.

## 9. Explicitly not proposed

TipTap or streamdown replacement, always-live SSE, client-store-as-truth, per-tool `makeAssistantToolUI` cascade, version unpinning or de-forking react-ag-ui by upgrade, reviving dispatch tables, PartyKit transport rewrite for the xread fan-out (the shared-subscriber fix in §4.3 captures most of it), and deleting `dbMessages`/`sidePanel.messages` from the view-model (audited: live render consumers — the side panel renders them).
