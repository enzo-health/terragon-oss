# Streaming reliability audit — daemon → frontend, startup, Slack/Linear

**Date:** 2026-07-03 · **Branch:** chore/aa · **Method:** 4 completed rounds of 10 parallel opus auditors (read-only, file:line evidence + concrete failure scenario required), each round adversarially verified by a Fable analyst before entering the ledger. 31 findings confirmed, 2 refuted.

**Scope note:** The run was chartered for 10 rounds but stopped at round 5 on a billing limit. Rounds 1–4 completed and are reported here in full. Rounds 1–2 swept breadth; rounds 3–4 dug into the leads. Coverage of the daemon emit path, ingest, SSE/replay, client transport, lifecycle fencing, startup, follow-up/stop, Linear, Slack, and cross-cutting durability is solid; the deeper load-behavior and operator-recovery lanes (chartered for rounds 6–10) did not run.

## Executive summary

The persist path is sound. Bugs cluster in **recovery seams** — the second delivery, the missed delivery, the resume after a drop. The recurring signature: a route that ACKs its caller (returns 200, or re-schedules a retry) while its side effect silently failed, had no idempotency, or had no driver to complete it. A second signature showed up in rounds 3–4: **nothing enforces "one active run per thread chat"** — dispatch, ingest, stop, and checkpointing all assume it, none enforce it — so a single slow boot cascades into duplicated output, racing commits, and a stop that only reaches one of two running sandboxes.

The five that matter most:

1. **Slow boots are falsely requeued, causing two concurrent runs on one thread** (S4). A legitimate 6–14 min boot trips the 5-min stale-booting cron because boot progress never bumps `updatedAt`. A second run is dispatched; the original also completes. Two agents now edit the same repo — duplicate output, racing commits/PRs, session collision. This is the root cause behind findings 4 and 9.
2. **Follow-up retry jobs are scheduled but never drained** (S4). `drainDueFollowUpRetryJobs` has zero production callers (test-only) and no cron invokes it. Every transient follow-up dispatch failure writes a Redis ZSET job that never fires — the follow-up is stuck `Queued` forever. This is the mechanism behind the stuck `Queued(1)` fixtures in the dev DB.
3. **Failed batch follow-up loses the user's message** (S4). The batch drain clears the queue _before_ dispatching; on dispatch failure the retry snapshot re-reads `[]`, and `[] ?? fallback` returns `[]` (empty array is not nullish), so the fallback never fires. The text is gone, never written to `messages[]`, with a false "retrying" notice shown.
4. **Daytona keepalive is a no-op; the sandbox auto-stops mid-run** (S4). `DaytonaProvider.extendLife` calls `refreshData()` (metadata refetch), not `refreshActivity()`, so the 15-min auto-stop timer is never reset. Any >15-min gap between control-plane calls (long turn, one long tool, rate-limit park) kills the sandbox, the daemon, and all unflushed text. Daytona-only; E2B/Docker are unaffected, so CI misses it.
5. **A partial Redis XADD failure leaves a permanent hole in the live stream** (S3). If a publish pipeline halts mid-batch, those seqs persist to Postgres but never reach the stream; the viewer's `lastDeliveredSeq` advances past the gap via `Math.max` and never re-reads it. Assistant text and tool events are lost for connected viewers, with no self-heal on a busy stream.

The good news: the confirmed list is dominated by **recovery-path** defects, not happy-path corruption. Normal streaming works. The failures need a trigger — a slow boot, a dropped socket, a retried webhook, a Daytona sandbox, a mid-run partition. Each is individually fixable without touching the core fold or the persist pipeline.

---

## Confirmed findings (ranked by severity)

### S4 — loss or corruption under a plausible race

**F1. Slow boots falsely requeued → second concurrent run on one thread chat**
`apps/www/src/server-lib/booting-recovery.ts`, `apps/www/src/agent/msg/startAgentMessage.ts`, `apps/www/src/app/api/internal/cron/stalled-tasks/route.ts`, `apps/www/src/server-lib/process-queued-thread.ts`
A new-thread boot legitimately takes 6–14 min (timeout 15 min). `bootTransition` sets `status=booting, updatedAt=T0`; boot progress calls `updateThread` (thread table only), so the thread-chat `updatedAt` stays T0. The hourly stalled-tasks cron at ~T0+6min sees `booting` + `updatedAt <= now-5min` and requeues; the queued-tasks cron dispatches a **second** run. The original boot finishes, checks only for `complete`/`stopping`, and dispatches its own run. Two runs on one chat: duplicate output, racing commits/PRs, session collision.
_Fix:_ Bump the thread-chat `updatedAt` on every boot-progress heartbeat, or raise the stale threshold above the real boot ceiling, or make dispatch a status CAS (`booting → working`) that the loser can't win.

**F2. Follow-up retry jobs scheduled but never drained (orphaned Redis retry queue)**
`apps/www/src/server-lib/follow-up-retry-jobs.ts`, `apps/www/src/server-lib/process-follow-up-queue.ts`, `apps/www/vercel.json`
Turn completes; `checkpoint-thread.ts:160` calls `maybeProcessFollowUpQueue`; `dispatchAgentMessage` throws transiently. `handleFollowUpFailure` writes a job to Redis ZSET `dlrj:scheduled` plus a "retrying in ~2s" system message. Nothing pops that ZSET: `drainDueFollowUpRetryJobs` (defined at `follow-up-retry-jobs.ts:285`) has **zero production callers** and no cron invokes it. The follow-up is stuck `Queued` forever — this matches the dev DB's stuck `Queued(1)` fixtures.
_Fix:_ Add a cron entry that calls `drainDueFollowUpRetryJobs` on a short interval, mirroring the scheduled-tasks cron.

**F3. Failed batch follow-up loses the user's message (retry snapshot reads emptied queue)**
`apps/www/src/server-lib/process-follow-up-queue.ts`, `packages/shared/src/model/threads.ts`
Batch drain clears the queue first (`appendAndResetQueuedMessages:true`, line 801 → `threads.ts:811` sets `queuedMessages=[]`), then dispatches at line 819. If `dispatchAgentMessage` throws, `getLatestRetrySnapshot` (line 384) re-reads `[]`, and `[] ?? fallback` yields `[]` (an empty array is not nullish), killing the fallback. `handleFollowUpFailure` persists `replaceQueuedMessages:[]`; the follow-up text is lost, never in `messages[]`, and the retry finds nothing — permanent loss with a false "retrying" notice.
_Fix:_ Snapshot the queued messages _before_ the reset, and guard the fallback on `length`, not nullishness.

**F4. No single-active-run gate at daemon-event ingest → concurrent runs interleave in one transcript**
`apps/www/src/app/api/daemon-event/route.ts`, `apps/www/src/server-lib/ag-ui-publisher.ts`, `apps/www/src/app/api/ag-ui/[threadId]/route.ts`
The stale-boot requeue (F1) spawns run B (new runId + sandbox) while run A boots. Both daemons POST. Ingest validates each event only against its **own** runContext; nothing checks that the runId is the thread's current run. Both persist with distinct server-assigned per-threadChat seq. History projects by `threadChatId` across all runs; TranscriptStore dedups only by `(runId,eventId)`. A reload shows the assistant turn and tool calls duplicated and interleaved.
_Fix:_ Reject (or 202-park) ingest for any runId that isn't the thread chat's current active run; make F1's CAS the source of truth.

**F5. Daytona keepalive uses `refreshData()` not `refreshActivity()`; 15-min auto-stop kills the daemon mid-run**
`packages/sandbox/src/providers/daytona-provider.ts:823-828`, `packages/daemon/src/daemon.ts`
A Daytona run with a >15-min gap between control-plane SDK calls (long model turn, one long tool, rate-limit park). The daemon heartbeats every 5 min → `extendSandboxLife` → Daytona `extendLife` calls `refreshData()`, which does **not** reset the 15-min auto-stop timer (`refreshActivity()` is never called). At 15 min the sandbox auto-stops (RAM lost), killing the daemon and outbox; unflushed text is lost and the run is later swept `FAILED`. E2B's `setTimeout` keepalive works, so this is Daytona-only; Docker CI misses it.
_Fix:_ Call `sandbox.refreshActivity()` in `DaytonaProvider.extendLife`; add a non-docker test asserting the keepalive resets auto-stop.

**F6. Follow-up retry markers never pruned → a later follow-up's first failure exhausts instantly, message dropped**
`apps/www/src/server-lib/follow-up-retry-jobs.ts`, `apps/www/src/server-lib/process-follow-up-queue.ts`
Retry attempt-count markers from an earlier follow-up are never cleared after success/exhaustion, so a subsequent unrelated follow-up inherits an already-maxed attempt count. Its very first transient failure is treated as terminal — dropped with no retry.
_Fix:_ Clear the per-follow-up retry marker on success and on terminal drop; key markers by the specific follow-up submission, not the thread.

**F7. Concurrent Linear token refresh: loser deactivates the installation, killing the winner's valid token**
`apps/www/src/server-lib/linear-oauth.ts`, `apps/www/src/app/api/webhooks/linear/handlers.ts`, `packages/shared/src/model/linear.ts`
Token near expiry; two concurrent org webhooks read the same access `AT0`/refresh `RT0`. The winner rotates `RT0`. The loser's refresh with the dead `RT0` hits `invalid_grant`, re-reads before the winner's DB write, still sees `AT0`, and deactivates the install via CAS on `AT0`. The winner's write then requires `isActive=true`, matches 0 rows, and returns `reinstall_required`. The fresh token is never persisted and `RT0` is dead — the workspace is stuck in a false "reinstall required" until manual reinstall.
_Fix:_ Serialize refresh under a per-org advisory lock or `SELECT … FOR UPDATE`; or gate `invalid_grant` deactivation behind a bounded re-read poll for the winner's rotation.

### S3 — degraded reliability under a race or restart

**F8. Non-auth POST failures retry forever and head-of-line-block the thread (poison batch → stuck run)**
`packages/daemon/src/daemon.ts`
An oversized body (large tool result >4.5MB → Vercel 413, enforce-mode validator 400, or persistent 500). `isNonRetryableAuthError` (256-265) treats only 401/403 as terminal, so these retry. At max attempts `flushThread` does not drop the batch: `backoff.reset()` + reschedule (4225-4237) loops forever. `getPendingBatchEntriesForThread` (3590-3608) pins every retry to the same head batch, so later messages and the terminal never send. The run is stuck `working`; `messageBuffer` grows unbounded.
_Fix:_ Treat 4xx (except 429) as non-retryable; on give-up, drop the poison batch and emit a synthetic error terminal so the run doesn't hang.

**F9. Outbox journal records only at POST time; buffered-but-unflushed messages are lost on SIGKILL with no replay**
`packages/daemon/src/daemon.ts`
`addMessageToBuffer` (3818) only buffers in memory; journaling happens in `sendMessagesToAPI` at POST time (4491). During a retry backoff (up to 60s) the thread is gated/skipped (3877-3884) while the agent keeps emitting messages that pile up un-journaled. A sandbox OOM/SIGKILL loses the buffer, and the journal has no record, so replay recovers nothing. The agent won't re-emit → permanent loss; if the terminal was lost, the thread stays `working`. Teardown also skips gated threads (single flush at 4620).
_Fix:_ Journal at buffer time, not POST time; flush gated threads on teardown.

**F10. Terminal Linear agent activity re-emitted on every daemon retry (duplicate final answer in Linear)**
`apps/www/src/app/api/daemon-event/route.ts`, `apps/www/src/server-lib/linear-agent-activity.ts`
A completed/failed terminal batch on a linear-mention thread schedules the Linear terminal `response`/`error` at `route.ts:1236`, then the route hits a downstream non-2xx (409/500/503 at ~1399/1518/1617) or the 200 is lost. The daemon retries the identical batch; the fence returns `duplicate`, but the Linear block at 1223 still runs (`isDone` recomputed true), so the final answer is posted to the Linear issue a second time.
_Fix:_ Move the Linear terminal emission inside the fenced transaction so `duplicate` short-circuits it, or dedup on the terminal event id.

**F11. Partial Redis XADD failure leaves a permanent hole in the live stream for connected viewers**
`apps/www/src/server-lib/ag-ui-publisher.ts`, `apps/www/src/app/api/ag-ui/[threadId]/route.ts`, `apps/www/src/server-lib/ag-ui/thread-event-live-tail.ts`
An active run: `publishAgUiEventsBatch` hits a partial pipeline failure and halts at `failedResultIndex`, so seq 100–110 persist to DB but never XADD; the next batch publishes 111+ fine. A live-tailing viewer delivers up to 99, then 111+, advancing `lastDeliveredSeq` via `Math.max` to 111 (route 287-291), skipping the hole. A busy stream means idle catch-up rarely runs; when it does, `afterSeq = lastDeliveredSeq` (>111) never re-reads 100–110. Those events are lost for that viewer.
_Fix:_ Detect a seq gap on live-tail (delivered seq > lastDelivered+1) and backfill from Postgres before advancing the cursor.

**F12. Mid-run SSE drop / 300s maxDuration cap does not self-reconnect; live text goes dark**
`apps/www/src/components/chat/transcript-view/use-live-transcript.ts`, `apps/www/src/components/chat/chat-ui.tsx`, `apps/www/src/app/api/ag-ui/[threadId]/route.ts`
A run exceeds 5 min; Vercel closes the SSE at `maxDuration=300` and `runAgent()` in `connectResume` settles. The catch only increments the failure count + `classifyTransportError`, never re-invoking `connectResume` (use-live-transcript 202-214). Reconnect fires only on effect re-run, whose dep `loadHistory` changes only when `isAgentCurrentlyWorking` or the snapshot changes (chat-ui 387-392). With status stable `working`, nothing re-opens the stream, so the transcript freezes until the run ends.
_Fix:_ On a clean SSE close while status is still `working`, re-invoke `connectResume` with backoff.

**F13. Swallowed rate-limit recovery transition becomes a permanent deadline-sweep failure instead of auto-resume**
`apps/www/src/app/api/daemon-event/route.ts`, `apps/www/src/server-lib/daemon-event/route-recovery.ts`, `apps/www/src/server-lib/run-deadline-sweep.ts`, `apps/www/src/agent/machine.ts`
The rate-limit run-terminal is dropped and unfenced, so only `applyRouteRecoveryRateLimit` moves the chat out of `working`. It is awaited in a log-only try/catch (1656-1675) and 200 is still returned (1682), so the daemon never retries. If that write throws (transient DB) or NOOPs because the status isn't `booting`/`working` (machine.ts:97,110), the chat stays `working` with no `reattemptQueueAt`, is never resumed, and the 15-min deadline sweep fences it as `failed` (run-deadline-sweep.ts:45) — the rate-limit resume is lost.
_Fix:_ Persist the recovery transition inside the fenced transaction; on failure return non-2xx so the daemon retries.

**F14. Fire-recovery (oauth/context-exhausted) non-atomic, marker-first, failure swallowed, route 200-acks**
`apps/www/src/server-lib/daemon-event/route-recovery.ts`, `apps/www/src/app/api/daemon-event/route.ts`
For context-exhausted/oauth-revoked the outcome is `fire`, so the run is forced completed (route.ts:863) and fenced _before_ `applyRouteRecoveryFire` runs. That call writes the invalid-token marker first, then persists a side-effect message and queues "Continue" in two more separate non-transactional awaits (route-recovery.ts:145-171). If any throws, the marker is set but no continuation is queued; the catch (1629-1653) logs and falls through to the 200 ack. The thread looks complete but never auto-continues, and — because the marker makes future `planRouteRecovery` return no-recovery — the state is permanent.
_Fix:_ Wrap marker + side-effect + Continue in one `db.transaction`; persist the marker last; return 503 on failure so the daemon retries.

**F15. Run-state cleanup ignores buffered deltas; re-minted runId defeats dedup and duplicates final text**
`packages/daemon/src/daemon.ts`, `packages/agent/src/ag-ui-rows.ts`, `apps/www/src/server-lib/ag-ui-publisher.ts`, `apps/www/src/app/api/daemon-event/route.ts`
Run completes: `killActiveProcess` marks cleanup (967-969) while final deltas remain buffered. The delta-only tail flush POSTs them; the server persists rows (route.ts:1014) but the ack is lost, so the catch re-prepends and retries (4133-4140). `maybeCleanupDaemonEventRunState` (3557-3574) then deletes the state (it never checks `deltaBuffer`). The retry mints a fresh random runId (3390); the re-sent rows embed it, so dedup keyed on `${runId}:${eventId}` (ag-ui-publisher.ts:294) misses and the final message duplicates.
_Fix:_ Don't delete run state while the delta buffer is non-empty; pin the delta envelope's runId across retries.

**F16. Stop reaches only the newest run/sandbox; the orphaned earlier run keeps streaming after "stopped"**
`apps/www/src/server-lib/stop-thread.ts`, `apps/www/src/agent/sandbox.ts`, `apps/www/src/app/api/daemon-event/route.ts`
After a double-dispatch (F1), `thread.codesandboxId` is overwritten with sandbox B (sandbox.ts:794-795). Stop uses `getLatestAgentRunContextForThreadChat` (ORDER BY `updatedAt` DESC), fencing only run B and sending `stop` to sandbox B. Run A never gets stop; its runContext stays `processing`, so ingest keeps accepting and projecting its events (route.ts:600,1032-1039). The chat shows stopped, but run A keeps coding, billing, and growing the transcript until it finishes or idle-hibernates.
_Fix:_ Stop must fence and signal _all_ active runs for the thread chat, not just the latest.

**F17. Linear `prompted` follow-up redelivery queues the same message twice (no dedupe guard)**
`apps/www/src/app/api/webhooks/linear/handlers.ts`, `apps/www/src/server-lib/follow-up.ts`, `apps/www/src/app/api/webhooks/linear/route.ts`
A follow-up on an existing Linear-issue thread sends `action:prompted`. `handlers.ts:596` calls `queueFollowUpInternal` with `source:'www'`, no `dedupeMarker`, ignoring `deliveryId`. If the awaited handler throws (`route.ts:298` has no try/catch) or exceeds Linear's timeout, Linear redelivers. `queueFollowUpInternal` dedups only for `dedupeMarker` or `source==='github'`, so the second delivery appends a duplicate message and the agent runs it twice.
_Fix:_ Pass Linear's `deliveryId` as the dedupe marker.

**F18. Scheduled automations not atomically claimed: partial failure duplicates the task**
`apps/www/src/server-lib/automations.ts`, `packages/shared/src/model/automations.ts`, `apps/www/src/app/api/internal/cron/automations/route.ts`
`getScheduledAutomationsDueToRun` is a plain `SELECT WHERE nextRunAt<=now`, with no claim. `runAutomation` calls `createNewThread` **first** (inserts thread + dispatches run), **then** advances `nextRunAt`; errors are swallowed without advancing it. If the snapshot write or `nextRunAt` update throws, or the function is killed after `createThread` commits, the thread exists but `nextRunAt` stays past — the next 30-min tick re-fires and creates a second thread+run. (scheduled-tasks avoids this via a `fromStatus` CAS.)
_Fix:_ Claim the automation with a CAS on `nextRunAt` before creating the thread.

**F19. Sidebar thread list has no reconnect/close resync — stuck "working" spinner after a transient PartySocket gap**
`apps/www/src/components/thread-list/use-thread-list.ts`, `apps/broadcast/src/server.ts`, `apps/www/src/lib/query-client.ts`
The sidebar shows thread X `working`. The socket briefly drops (sleep/WiFi/deploy). During the gap the run finishes and ingest publishes `working → complete`; `broadcast/server.ts` is a stateless pass-through, so the disconnected viewer loses the patch. PartySocket reconnects, but `use-thread-list.ts:152` has **no** `onClose`. With `refetchOnWindowFocus:false`, no interval, and the sidebar always mounted, the list never resyncs — X spins `working` until a hard reload.
_Fix:_ Add an `onClose` to the thread-list realtime hook that invalidates the list query on reconnect, mirroring the chat page's `onStreamClose`.

**F20. User-channel PartySocket permanently dead after a sustained outage (no resync)**
`apps/www/src/hooks/useRealtime.ts`, `apps/www/src/hooks/realtime-socket-state.ts`
A ~13min+ outage with the tab open exhausts `maxRetries=10`; partysocket 1.1.4 then sets `_connectLock=true` and early-returns without resetting it, bricking the socket so `reconnect()` no-ops. No `online` listener exists. `getOrCreateRealtimePartySocket` returns the dead cached singleton forever, and the user channel uses `trackReadyState:false`, so the online→reconnect handler is never wired. On network return, thread status, meta chips, and the sidebar freeze until a full reload.
_Fix:_ Add a window `online` listener that recreates the socket singleton; raise or reset the retry lock.

**F21. Slack webhook has no event-id / retry dedup — duplicate threads and acks on Slack retry**
`apps/www/src/app/api/webhooks/slack/route.ts`, `apps/www/src/app/api/webhooks/slack/handlers.ts`
Slack retries if it doesn't get 200 within 3s. On a Vercel cold start the sync prelude can exceed 3s, so Slack re-POSTs the `app_mention`. `route.ts:100-111` fires `waitUntil(handleAppMentionEvent)` with no `X-Slack-Retry-Num` / `event_id` check; `newThreadInternal` has no idempotency on `event.ts`. Result: two threads for one mention plus two "✅ Task created" messages — the same shape as the confirmed Linear duplicate.
_Fix:_ Short-circuit when `X-Slack-Retry-Num` is present, and dedup on `event_id`/`event.ts` via Redis `SETNX` before `newThreadInternal`.

**F22. Outbox journal grows unbounded under a poison batch (compaction only reclaims acked)**
`packages/daemon/src/outbox-journal.ts`, `packages/daemon/src/daemon.ts`
A message POST fails persistently and (per F8) retries forever. Each retry re-journals the same pinned eventId (daemon.ts:4491; outbox-journal.ts:218). The event is never acked; compaction keeps every unacked event and fires only on an ack (outbox-journal.ts:222,241-247). The delta tail mints a new eventId per attempt (daemon.ts:4130,3494), so copies aren't dedupable on read. Over a stuck thread, `/tmp` fills, breaking journal writes, agent scratch, and git.
_Fix:_ Journal each `(runId,eventId)` at most once; pin the delta envelope eventId across retries.

**F23. Unbounded delta/message/meta buffers: a network partition mid-run OOM-kills the daemon and loses the whole turn**
`packages/daemon/src/daemon.ts`
The sandbox loses connectivity mid-turn, so every `serverPost` throws. On a non-auth failure, drained entries are re-prepended (4509-4513, 4135-4139, 4199-4204), nothing dropped, while the running agent keeps pushing new deltas/messages (3806,3820). No size cap exists on any of the three buffers. A long turn accumulates tens of MB in RAM until the daemon OOM-crashes; the buffered turn is then lost (see F9) and the run is stuck `working` until the deadline sweep.
_Fix:_ Cap each buffer by bytes/entries; on overflow, force-persist to the journal and drop from RAM, or apply backpressure to the agent.

**F24. Stale `liveTailParams.runId` makes idle reconcile kill an auto-dispatched follow-up run mid-stream**
`apps/www/src/app/api/ag-ui/[threadId]/route.ts`, `apps/www/src/server-lib/ag-ui/thread-event-live-tail.ts`, `apps/www/src/server-lib/ag-ui/ag-ui-sse-session.ts`
Run 1's terminal is lost for a viewer (the F11 XADD hole, or a connection in `XREAD_BACKOFF`), so it never closes at `route.ts:298`. The server auto-dispatches queued run 2 on the same stream; live-tail emits run 2's `RUN_STARTED` and keeps streaming, but `liveTailParams.runId` stays run 1. On run 2's first ~4s idle, reconcile runs with `runId=run 1`, reads its terminal status, emits run 1's terminal, and closes. Run 2 goes dark (no self-reconnect, per F12) until remount.
_Fix:_ When live-tail emits a `RUN_STARTED` with a new runId, reassign `liveTailParams.runId` so reconcile targets the streaming run.

**F25. Slack `app_mention` acked 200 then processed in `waitUntil`: a killed lambda drops the mention silently**
`apps/www/src/app/api/webhooks/slack/route.ts`, `apps/www/src/app/api/webhooks/slack/handlers.ts`, `apps/www/src/server-lib/new-thread-shared.ts`
`route.ts:106` returns 200 and defers `handleAppMentionEvent` to `waitUntil`. That handler awaits serial Slack API calls plus `newThreadInternal` before persisting any row (`createThread` at new-thread-shared.ts:180). If the function hits its execution ceiling while Slack is slow/rate-limited, `waitUntil` is killed before `createThread`. Slack already got 200 and never retries; no `event_id`/`ts` record detects the miss, so the mention is silently dropped — no thread, no error.
_Fix:_ Persist an idempotent "received" record before the 200 ack; drive thread creation from a durable queue rather than `waitUntil`.

**F26. Slack "Try Again" button throws and silently no-ops**
`apps/www/src/app/api/webhooks/slack/handlers.ts`, `apps/www/src/app/api/webhooks/slack/route.ts`
`sendSetupMessage` stores `retryData = {text,channel,user,thread_ts,team}` (handlers.ts:340-346), omitting `ts`. After setup, "Try Again" rebuilds the event with `ts=undefined` (route.ts:88). `handleAppMentionEvent` passes the setup gates, then `getSlackMessagePermalink({messageTs: undefined})` hits `handlers.ts:143` `messageTs.replace('.','')` → TypeError. The outer catch (535-537) only logs. No thread, no Slack reply — the button is dead and the user is stuck.
_Fix:_ Include `ts: event.ts` in `retryData`; guard `getSlackMessagePermalink` against a missing `messageTs`.

**F27. Deploy-skew: recoverable terminal from a non-v2 daemon dropped with no recovery, stranded until deadline sweep**
`apps/www/src/app/api/daemon-event/route.ts`, `apps/www/src/server-lib/run-deadline-sweep.ts`
An old daemon emits a canonical run-terminal but no `envelopeV2` and no recoverable stamp, then rate-limits. The legacy sniffer sets `isRecoverableResult=true`, but `isV2Batch` is false, so `recoveryPlan` is null. `dropRecoverableRunTerminal` is true (filters the terminal) while `routeOwnsRecovery` is false. Status collapses to `processing`, so the terminal fence never runs. The run sits `working` with no auto-resume until run-deadline-sweep (15-min cutoff) generic-fails it, losing the rate-limit resume.
_Fix:_ When the sniffer flags recoverable but the batch isn't v2, take route ownership of recovery instead of dropping the terminal.

**F28. Daytona-only boot failure: setup clone/installer hit a 5-min default command timeout**
`packages/sandbox/src/providers/daytona-provider.ts`, `packages/sandbox/src/setup.ts`, `packages/sandbox/src/providers/e2b-provider.ts`, `packages/sandbox/src/providers/docker-provider.ts`
On Daytona, a large blobless clone (setup.ts:633) or heavy installer (setup.ts:606) with no explicit `timeoutMs` inherits `DEFAULT_TIMEOUT_MS=5min` (daytona-provider.ts:25,690) and throws at :704/715 once it exceeds 5 min. The same commands on E2B (e2b:114, `timeoutMs||0`) and Docker (docker:108, `timeout||0`) are unbounded and succeed. A repo that clones in 6–8 min boots fine on E2B/Docker but fails boot on Daytona only, reported as a misleading "timed out after 0ms".
_Fix:_ Default Daytona `runCommand` to `0`=unbounded like E2B/Docker, or pass explicit generous `timeoutMs` to clone/fetch/installer; fix the error to report the real limit.

### S2 — minor or serverless-bounded

**F29. Outbox journal append is fire-and-forget, not awaited before the POST — crash window loses the event**
`packages/daemon/src/outbox-journal.ts`, `packages/daemon/src/daemon.ts`
`appendRecord` schedules the append via `void this.enqueue(...)` (outbox-journal.ts:214) and returns synchronously; `journalOutboundEvent` is not awaited. The sequence is journal → await `serverPost` → ack (4491-4493), but group entries were already removed from `messageBuffer` at 3928. A SIGKILL before the `appendFile` syscall completes (widened when the write chain backlogs under 60fps deltas) leaves the buffer empty **and** the journal empty → the event isn't replayed, the batch is lost.
_Fix:_ Await the journal append before removing entries from the buffer.

**F30. Persistent resume-failure counter permanently disables live streaming after 3 cumulative failures**
`apps/www/src/components/chat/transcript-view/use-live-transcript.ts`
During a brief deploy/outage, incidental effect re-runs (status polling toggling `isAgentCurrentlyWorking`) drive 3 `connectResume` failures, so `resumeFailureCountRef` hits 3. After recovery, every later legitimate re-run hits the early-return at 190-195 and never calls `runAgent` again — the stream stays permanently closed. The reset happens only on a new agent instance (154), a successful `runAgent` (204), or a manual retry (257), so a healthy server plus a normal status change cannot reopen it.
_Fix:_ Reset the failure counter on a successful reconnect _or_ after a cooldown window, not only on the three listed events.

**F31. Observe-mode write validator's per-run state map is never pruned — unbounded memory on the ingest hot path**
`apps/www/src/server-lib/ag-ui-publisher.ts`, `apps/www/src/server-lib/ag-ui/run-protocol-validator.ts`
Validation defaults to `observe` (always on). Every persist batch caches a `RunProtocolState` per runId in the module-level `runProtocolStateStore`. Only `.get` (93) and `.set` (113) are used; `.delete` (validator 449) has zero callers, so a run's state is retained forever after it terminates. On a long-lived/self-hosted node instance handling thousands of runs, the Map grows one entry (3 Sets) per distinct runId ever seen, leaking monotonically on the write path. Serverless recycling caps it, hence S2. Also observed on this path: when the singleton lacks the runId (cold instance), `validateRowsForPersist` calls `getAgUiEventEnvelopesForRun` — an unbounded `findMany` over all run rows, discarded in observe mode — so late-run cold batches re-read the whole log, O(n) each, amplifying POST latency (a contributing factor to F8-style head-of-line blocking).
_Fix:_ Evict on terminal (`delete(runId)` when the batch carries `RUN_FINISHED`/`RUN_ERROR`), or back the store with an LRU/TTL cap.

---

## Refuted claims (do not re-chase)

- **"Interrupted tool-result injection lost permanently → tool calls stuck 'running'."** The client fold closes unresolved tools on `RUN_FINISHED`/`RUN_ERROR` (`apply-ag-ui-event.ts:314-315,334-335`), and the durable history projection synthesizes unresolved-result rows (`durable-history-builder.ts:150-161,390-405`). The claimed stuck-UI state cannot occur.
- **"Rate-limited runs are never fenced terminal, so liveness reports a parked run as active forever."** The mechanics are real (route.ts:842-848 drops the terminal; the sweep excludes `queued-agent-rate-limit`), but the harm doesn't hold: `runActive=true` keeps viewers on the threadChat-scoped stream so the resumed run streams live, and the reattempt dispatches a **new** run whose `RUN_STARTED` supersedes the parked one. (Note: F13 is a _different_, confirmed failure on this same path — the swallowed-write branch, not the happy resume.)

---

## Coverage map

Traced across the 4 completed rounds: daemon emit + outbox journal + flush chain (F8,F9,F22,F23,F29); ingest route fence/validator/persist∥publish (F4,F10,F13,F14,F27,F31); SSE + seq-cursor replay + live-tail reconcile (F11,F24); client transport/reconnect (F12,F30); terminal fencing + recovery (F13,F14,F15,F16); startup + sandbox providers (F1,F5,F28); follow-up/queue/stop (F2,F3,F6,F16); Linear (F7,F10,F17); Slack + broadcast (F19,F20,F21,F25,F26); automations/cron (F18).

**Not reached** (chartered for rounds 5–10, unrun): load-behavior ceilings under many concurrent viewers/runs, operator/admin unstick paths, migration-in-flight behavior, and the ack lifecycle of Delivery Loop v3 under poison messages. Re-run rounds 5–10 to cover these.

## Recommended fix order

1. **F1 + F4 + F16 together** — the single-active-run invariant. F1's CAS is the root fix; F4 and F16 fall out of enforcing it. This one change closes the largest cluster (duplicate output, interleaved transcript, half-stop).
2. **F2 + F3 + F6** — the follow-up queue. Wire the retry-drain cron (F2), snapshot-before-reset (F3), and per-submission retry markers (F6). Clears the stuck `Queued(1)` class outright.
3. **F5 + F28** — Daytona parity (`refreshActivity` + unbounded setup timeouts). Two small provider fixes; add non-docker tests so CI stops hiding them.
4. **F13 + F14 + F15** — make terminal recovery transactional. Persist recovery side effects inside the fence; return non-2xx on failure.
5. **F11 + F12 + F24 + F30** — the live-stream resume seam. Gap-backfill on live-tail, self-reconnect on clean close, retarget reconcile, and reset the failure counter.
6. **F10 + F17 + F21 + F25** — webhook idempotency (Linear + Slack dedup on delivery/event id; durable receipt before ack).
7. Remaining S2/S3 as capacity allows.
