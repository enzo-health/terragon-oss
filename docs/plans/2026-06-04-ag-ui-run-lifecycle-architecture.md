# AG-UI Run-Lifecycle Architecture — plan of record

Status: W1–W5 landed. The canonical `run-terminal` is the **sole** completion authority
(`51b08b44`): the legacy message-sniffing path (`deriveRunStatusFromMessages` +
`deriveDaemonTerminalErrorInfo` + `deriveTerminalFailureSource` + the
`requires-v2-envelope` 409 + legacy terminal synthesis) is DELETED, and the ACP `/status`
poll is removed (`4ce35469`). Per the no-backwards-compatibility decision, un-rebundled
daemons that emit only the legacy message are no longer completed by the route — the
`run-deadline-sweep` backstops them. **W6 (free the composer during git checkpoint) is the
one remaining piece and is NOT done**: it requires moving checkpoint to a runId-leased
post-terminal effect, because freeing the composer makes a follow-up start a new run that
races the in-flight git checkpoint (a data-corruption race, not a compat concern). That
needs integration-harness verification. Branch: `fix/acp-streaming-followups`.

## Thesis

Implement AG-UI's run lifecycle faithfully on the server, bounded by Temporal-style
deadlines, with Vercel-style Last-Event-ID replay for reconnect. Not a bespoke protocol —
AG-UI already defines the contract (`@ag-ui/client` `verifyEvents`: one `RUN_STARTED`
opens, exactly one `RUN_FINISHED|RUN_ERROR` closes, status is a left-fold over a typed
append-only event stream). Our bug is that we violate it intra-process; the fix completes
wiring that mostly already exists.

## The single authority

One canonical `run-terminal{status,reason}` per run is the sole end-of-turn signal. The
server projects DB status from it. DB status is the single client liveness authority.
A missing terminal degrades to a synthesized `timeout` terminal in minutes — a permanent
`working` hang is structurally impossible.

## What already exists (do not rebuild)

- `OperationalRunTerminalEvent` schema (`packages/agent/src/canonical-events.ts:72`).
- Server consumer prefers it: `findCanonicalRunTerminalEvent` /
  `buildCanonicalRunTerminalEvent` / `splitCanonicalEventsForCommit` (event-commit.ts);
  `route.ts:848` reads `canonicalTerminal` before falling back to message-sniffing.
- Client reducer already handles `RUN_FINISHED` / `RUN_ERROR` / `CUSTOM
thread.status_changed` (`thread-view-model-lifecycle-events.ts:130-176`).
- AG-UI server scaffolding: `last-event-id` replay (`api/ag-ui/[threadId]/route.ts:88`),
  runId-fenced auto-`RUN_FINISHED` (`ag-ui-sse-session.ts:250-262`),
  `synthesizeTerminalEntry` degrade-to-terminal (`terminal-event-synthesizer.ts`).
- Emit API: `broadcastAgUiEventEphemeral({ threadChatId, event })` (ag-ui-publisher.ts:481).

## The gaps (this plan)

### W1 — server emits `thread.status_changed` (fixes existing sandboxes)

`apps/www/src/agent/update-status.ts`: after a successful status transition
(`didUpdateStatus`), emit an AG-UI `CUSTOM` event via `broadcastAgUiEventEphemeral`:
`{ type: EventType.CUSTOM, name: "thread.status_changed", value: { status: updatedStatus } }`.
The client consumer already exists. Fire-and-forget; a Redis hiccup must not block the DB
write. This makes a correct DB `complete` reach the client even if `RUN_FINISHED` was lost.

### W2 — Temporal-style deadline sweep (fixes existing sandboxes)

New fast cron `api/internal/cron/run-deadline-sweep` (1-2 min). Reuse
`getStalledThreadChats` with a short cutoff (~10-15 min). For each stuck run, drive a fenced
`run-terminal{failed, reason:"timeout"}` through the same terminal path
(`completeAgentRunContextTerminal` + `updateThreadChatWithTransition`) so all layers
converge on one projection. Keep the hourly `stopStalledThreadChats` as a coarse safety net
(it also hibernates sandboxes). Idempotent on runId.

### W3 — client de-latches from the local promise

`thread-view-model/reducer.ts`: make `shouldPreserveLocalLifecycle` subordinate to
authoritative status — any `thread.status_changed`/`RUN_FINISHED`/`RUN_ERROR` and any
terminal-status snapshot wins over the local latch. Give optimistic `RUN_STARTED` a
client-side TTL (~15s, distinguished from confirmed `booting`) that reverts to the
snapshot's DB status. Fire `server.refetch-reconciled` on an SSE close without a received
terminal. Belt-and-suspenders: a dropped `thread.status_changed` self-corrects.

### W4 — daemon emits the canonical terminal

`packages/daemon/src/daemon-canonical-events.ts`: `buildCanonicalEventsForBatch` emits
`OperationalRunTerminalEvent` as the last event of a run whenever the batch contains a
terminal ClaudeMessage (move the `result.is_error→failed` / `custom-stop→stopped` /
`custom-error→failed` / `success→completed` mapping up into the normalizer). Route all
terminal signals (ACP POST result, Codex WS turn-complete, legacy NDJSON `result`, the
watchdog) through one idempotent `finalizeTurn(runId, status, reason)` choke point guarded
by a per-run `terminalEmitted` flag. Generalize the idle watchdog to all transports,
reset on any canonical event.

### W5 — remove legacy

- Demote `deriveRunStatusFromMessages` to a back-compat shim only (canonical terminal is
  primary). Keep it — un-rebundled daemons still emit only the legacy `result` message.
- Remove the dead ACP `/status` poll fallback (daemon.ts) — only reached on
  `circuitBreakerTripped`; the watchdog + canonical terminal replace it.
- Stop treating `allowedTerminalResponseIds` as the load-bearing completion gate (keep the
  SSE echo as a redundant fast-path).
- Narrow the indefinite client `shouldPreserveLocalLifecycle` latch (folded into W3).

### W6 — decouple liveness from git checkpoint (flagged)

Flip `working-done`/`checkpointing` out of `primaryChatLive`
(`packages/shared/src/model/thread-lifecycle-policy.ts`) so `isAgentWorking` frees the
composer at turn-done; run checkpoint/PR as post-terminal effects. Behind a flag; verify
follow-up-during-checkpoint in the integration harness.

## Verification gate

`pnpm -C packages/daemon tsc-check`, `pnpm -C apps/www tsc-check`, plus targeted vitest:
`acp-adapter.test.ts`, `daemon.test.ts`, `daemon-canonical-events.test.ts`, `machine.test.ts`,
`thread-view-model/reducer.test.ts`, `event-commit.test.ts`, the ag-ui server-lib suites.

## Grounding

AG-UI `verifyEvents` (seam 1, 3) · Temporal Start-To-Close/Heartbeat timeouts (seam 4) ·
Vercel resumable-stream Last-Event-ID replay (seam 4) · Convex optimistic-overlay-yields
(seam 3). Pitch: "AG-UI's run lifecycle, bounded by deadlines so it can't wedge."
