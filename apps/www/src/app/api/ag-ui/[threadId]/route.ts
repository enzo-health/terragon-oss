import { type BaseEvent, EventType } from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import {
  type AgUiEventEnvelope,
  agUiStreamKey,
  getAgUiEventEnvelopesForRun,
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
  isTerminalAgentRunStatus,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { NextRequest, NextResponse } from "next/server";
import { getSessionOrNull } from "@/lib/auth-server";
import {
  replayQueryAfterSeq,
  resolveAgUiReplayCursor,
  shouldReplayEnvelope,
} from "@/lib/ag-ui-replay-cursor";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import { db } from "@/lib/db";
import { isLocalRedisHttpMode, redis } from "@/lib/redis";
import { buildRunTerminalAgUi } from "@/server-lib/ag-ui-publisher";
import { handleAgUiPostCommand } from "@/server-lib/ag-ui/ag-ui-command-handler";
import {
  captureStreamCursor,
  encodeSseComment,
  encodeSseEvent,
  emitStreamDiagnostic,
  isXreadTimeoutError,
  type StreamCloseReason,
  type StreamDiagnostics,
  MIN_XREAD_BLOCK_MS,
  MAX_XREAD_BLOCK_MS,
  XREAD_COUNT,
  KEEPALIVE_INTERVAL_MS,
  XREAD_BACKOFF_MS,
  BASELINE_SNAPSHOT_COMMENT,
  TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS,
  XREAD_ERROR_LOG_INITIAL_BUDGET,
  XREAD_ERROR_LOG_EVERY_N,
} from "@/server-lib/ag-ui/ag-ui-sse-writer";
import { projectThreadHistory } from "@/server-lib/ag-ui/thread-history-projector";
import { synthesizeTerminalEntry } from "@/server-lib/ag-ui/terminal-event-synthesizer";
import {
  buildResumeRunStartedEvent,
  getReplayDedupeKey,
  getReplayEntryRunId,
  isTerminalRunEventType,
  repairReplayTextMessageLifecycles,
  sseIdForReplayEntry,
  splitHistoryOnlyPrefix,
  toReplayEntries,
  type ReplayEntry,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import {
  getStringEventField,
  isValidKnownAgUiEvent,
  parseStreamEntries,
  type ReplayIdentity,
} from "@/server-lib/ag-ui/ag-ui-stream-entry";
import { authorizeAgUiThreadChat } from "./authorize-thread-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-lived SSE stream: request up to 5 minutes of serverless execution
// time (Vercel Pro cap). Client-side aborts close the stream early, so
// typical usage will not hit this ceiling.
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
) {
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");
  const runIdParam = request.nextUrl.searchParams.get("runId");
  const replayCursor = resolveAgUiReplayCursor({
    lastEventId: request.headers.get("last-event-id"),
    fromSeq: request.nextUrl.searchParams.get("fromSeq"),
  });
  const replayCursorSeq = replayCursor?.seq ?? null;
  const shouldFrameRunAgentResume = request.method === "POST";

  if (!threadChatId) {
    return NextResponse.json(
      { error: "Missing threadChatId" },
      { status: 400 },
    );
  }

  // Verify BOTH that the thread belongs to the session user AND that the
  // threadChatId belongs to that same thread. Without the join a caller
  // who owns thread-A could pass threadChatId pointing at someone else's
  // chat. Return 404 on mismatch to avoid leaking existence.
  const ownership = await authorizeAgUiThreadChat({
    threadId,
    threadChatId,
    userId: session.user.id,
  });

  if (ownership === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (request.nextUrl.searchParams.get("history") === "messages") {
    const projection = await projectThreadHistory({
      threadChatId,
      dbMessages: ownership.messages,
    });
    return NextResponse.json(projection);
  }

  const streamKey = agUiStreamKey(threadChatId);

  // Capture the live-tail cursor BEFORE the DB replay so in-flight events
  // published during the replay query window are not lost. This preserves
  // the at-least-once contract: client will receive all events for the run
  // (via DB replay) plus any new stream entries from this cursor onward.
  // Some duplicates are acceptable — AG-UI is designed to de-dupe by event
  // identity on the client.
  const initialLastId = await captureStreamCursor(streamKey);

  // Resolve the effective runId:
  //  - If the client supplied `?runId=X`, use it verbatim (reconnect path).
  //  - If the client supplied only a seq cursor, replay from that cursor
  //    thread-chat-wide. This is the history-adapter resume path; binding it
  //    to a guessed latest run can strand terminal events for delayed-start
  //    runs behind an unrelated older run.
  //  - Otherwise the connect is fresh; default to the thread chat's latest
  //    run. Clients that land on an empty thread chat (no runs yet) get a
  //    live-tailing stream with no history — the first RUN_STARTED written by
  //    a new daemon-event will naturally be the first event on the wire.
  let resolvedRunId: string | null = runIdParam;
  if (
    resolvedRunId === null &&
    replayCursorSeq === null &&
    request.method === "GET"
  ) {
    try {
      resolvedRunId = await getLatestRunIdForThreadChat({
        db,
        threadChatId,
      });
    } catch (error) {
      console.error(
        "[ag-ui] getLatestRunIdForThreadChat failed; defaulting to live-tail",
        { threadId, threadChatId },
        error,
      );
      resolvedRunId = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const diagnostics: StreamDiagnostics = {
        openedAtMs: Date.now(),
        firstFrameLatencyMs: null,
        replayCount: 0,
        dedupeCount: 0,
        xreadTimeoutCount: 0,
        xreadBackoffCount: 0,
        xreadErrorCount: 0,
      };
      let closed = false;
      let closeReason: StreamCloseReason | null = null;
      let keepaliveTimer: NodeJS.Timeout | null = null;

      const close = (reason: StreamCloseReason) => {
        if (closed) return;
        closed = true;
        closeReason = reason;
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
        emitStreamDiagnostic("stream_close", {
          threadId,
          threadChatId,
          runId: resolvedRunId,
          closeReason,
          firstFrameLatencyMs: diagnostics.firstFrameLatencyMs,
          replayCount: diagnostics.replayCount,
          dedupeCount: diagnostics.dedupeCount,
          xreadTimeoutCount: diagnostics.xreadTimeoutCount,
          xreadBackoffCount: diagnostics.xreadBackoffCount,
          xreadErrorCount: diagnostics.xreadErrorCount,
        });
        recordAgentTraceSpan({
          traceId: resolvedRunId,
          name: "server.agui.sse.closed",
          startedAtMs: diagnostics.openedAtMs,
          endedAtMs: Date.now(),
          attributes: {
            threadId,
            threadChatId,
            closeReason,
            replayCount: diagnostics.replayCount,
            dedupeCount: diagnostics.dedupeCount,
            xreadTimeoutCount: diagnostics.xreadTimeoutCount,
            xreadBackoffCount: diagnostics.xreadBackoffCount,
            xreadErrorCount: diagnostics.xreadErrorCount,
          },
        });
      };

      const markFirstFrameIfNeeded = () => {
        if (diagnostics.firstFrameLatencyMs !== null) {
          return;
        }
        diagnostics.firstFrameLatencyMs = Date.now() - diagnostics.openedAtMs;
        emitStreamDiagnostic("first_frame", {
          threadId,
          threadChatId,
          runId: resolvedRunId,
          firstFrameLatencyMs: diagnostics.firstFrameLatencyMs,
        });
        recordAgentTraceSpan({
          traceId: resolvedRunId,
          name: "server.agui.sse.first_frame",
          startedAtMs: diagnostics.openedAtMs,
          endedAtMs: Date.now(),
          attributes: {
            threadId,
            threadChatId,
            firstFrameLatencyMs: diagnostics.firstFrameLatencyMs,
          },
        });
      };

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          markFirstFrameIfNeeded();
          controller.enqueue(chunk);
        } catch {
          close("controller_enqueue_failed");
        }
      };

      emitStreamDiagnostic("stream_open", {
        threadId,
        threadChatId,
        runId: resolvedRunId,
        hasRunIdParam: runIdParam !== null,
        replayCursorSeq,
      });
      recordAgentTraceSpan({
        traceId: resolvedRunId,
        name: "server.agui.sse.opened",
        startedAtMs: diagnostics.openedAtMs,
        endedAtMs: diagnostics.openedAtMs,
        attributes: {
          threadId,
          threadChatId,
          hasRunIdParam: runIdParam !== null,
          replayCursorSeq,
        },
      });

      // Tear down on client abort. `once: true` handles listener cleanup.
      const abortSignal = request.signal;
      if (abortSignal.aborted) {
        close("client_abort_before_start");
        return;
      }
      abortSignal.addEventListener("abort", () => close("client_abort"), {
        once: true,
      });
      const replayedEventDedupeKeys = new Set<string>();
      let lastDeliveredSeq = replayCursorSeq;
      let hasEmittedAgUiDataEvent = false;
      let activeEmittedRunId: string | null = null;
      // Snapshot-first framing contract: always emit a baseline marker before
      // replay or live-tail frames so clients can align first-paint lifecycle.
      enqueue(encodeSseComment(BASELINE_SNAPSHOT_COMMENT));

      const rememberReplayedEventDedupeKeys = (
        event: BaseEvent,
        identity?: ReplayIdentity,
      ) => {
        const dedupeKey = getReplayDedupeKey(event, identity);
        if (dedupeKey !== null) {
          replayedEventDedupeKeys.add(dedupeKey);
        }
        if (identity !== undefined) {
          const structuralDedupeKey = getReplayDedupeKey(event);
          if (structuralDedupeKey !== null) {
            replayedEventDedupeKeys.add(structuralDedupeKey);
          }
        }
      };

      const consumeReplayedEventDedupeKey = (
        event: BaseEvent,
        identity?: ReplayIdentity,
      ): boolean => {
        const dedupeKey = getReplayDedupeKey(event, identity);
        if (dedupeKey !== null && replayedEventDedupeKeys.has(dedupeKey)) {
          replayedEventDedupeKeys.delete(dedupeKey);
          return true;
        }
        if (identity !== undefined) {
          const structuralDedupeKey = getReplayDedupeKey(event);
          if (
            structuralDedupeKey !== null &&
            replayedEventDedupeKeys.has(structuralDedupeKey)
          ) {
            replayedEventDedupeKeys.delete(structuralDedupeKey);
            return true;
          }
        }
        return false;
      };

      const ensurePostResumeStartsWithRun = (
        event: BaseEvent,
        identity?: ReplayIdentity,
      ): boolean => {
        if (
          !shouldFrameRunAgentResume ||
          hasEmittedAgUiDataEvent ||
          event.type === EventType.RUN_STARTED ||
          event.type === EventType.RUN_ERROR
        ) {
          return true;
        }

        const resumeRunId =
          resolvedRunId ??
          identity?.runId ??
          getStringEventField(event, "runId");
        if (resumeRunId === null) {
          console.error(
            "[ag-ui] cursored resume cannot infer run id before first live event",
            {
              threadId,
              threadChatId,
              firstType: event.type,
            },
          );
          const errorEvent = mapRunErrorToAgui(
            `Thread chat ${threadChatId} resume log is malformed: first event has no run id`,
            "replay_failed",
          );
          hasEmittedAgUiDataEvent = true;
          enqueue(encodeSseEvent(errorEvent));
          close("malformed_replay");
          return false;
        }

        resolvedRunId = resumeRunId;
        const runStartedEvent = buildResumeRunStartedEvent({
          threadId,
          runId: resumeRunId,
        });
        rememberReplayedEventDedupeKeys(runStartedEvent);
        hasEmittedAgUiDataEvent = true;
        activeEmittedRunId = resumeRunId;
        enqueue(encodeSseEvent(runStartedEvent));
        return true;
      };

      const emitAgUiEvent = (
        event: BaseEvent,
        seq: number | null,
        identity?: ReplayIdentity,
      ): boolean => {
        if (!ensurePostResumeStartsWithRun(event, identity)) {
          return false;
        }
        if (event.type === EventType.RUN_STARTED) {
          const nextRunId = getStringEventField(event, "runId");
          if (
            activeEmittedRunId !== null &&
            nextRunId !== null &&
            activeEmittedRunId !== nextRunId
          ) {
            enqueue(
              encodeSseEvent({
                type: EventType.RUN_FINISHED,
                threadId,
                runId: activeEmittedRunId,
              }),
            );
          }
          activeEmittedRunId = nextRunId;
          resolvedRunId = nextRunId;
        }
        hasEmittedAgUiDataEvent = true;
        enqueue(encodeSseEvent(event, sseIdForReplayEntry(seq, identity)));
        if (isTerminalRunEventType(event.type)) {
          const terminalRunId = getStringEventField(event, "runId");
          if (terminalRunId === null || terminalRunId === activeEmittedRunId) {
            activeEmittedRunId = null;
          }
        }
        return true;
      };

      const emitReplayEntry = (entry: ReplayEntry): boolean => {
        if (!isValidKnownAgUiEvent(entry.event)) {
          console.error("[ag-ui] threadChat replay: malformed AG-UI event", {
            threadId,
            threadChatId,
            runId: resolvedRunId,
            eventType: Reflect.get(entry.event, "type"),
            seq: entry.seq,
          });
          const errorEvent = mapRunErrorToAgui(
            `Run ${resolvedRunId} log contains malformed AG-UI event at seq ${entry.seq ?? "unknown"}`,
            "replay_failed",
          );
          emitAgUiEvent(errorEvent, null);
          close("malformed_replay");
          return false;
        }

        diagnostics.replayCount += 1;
        rememberReplayedEventDedupeKeys(entry.event, entry.identity);
        if (entry.seq !== null) {
          lastDeliveredSeq =
            lastDeliveredSeq === null
              ? entry.seq
              : Math.max(lastDeliveredSeq, entry.seq);
        }
        return emitAgUiEvent(entry.event, entry.seq, entry.identity);
      };

      const frameResumeReplayEntries = (
        replayEntries: ReplayEntry[],
      ): boolean => {
        if (
          replayCursorSeq === null ||
          !shouldFrameRunAgentResume ||
          replayEntries.length === 0
        ) {
          return true;
        }

        while (replayEntries[0]?.event.type === EventType.MESSAGES_SNAPSHOT) {
          const [entry] = replayEntries.splice(0, 1);
          if (entry?.seq !== null && entry?.seq !== undefined) {
            lastDeliveredSeq =
              lastDeliveredSeq === null
                ? entry.seq
                : Math.max(lastDeliveredSeq, entry.seq);
          }
        }

        if (
          replayEntries.length === 0 ||
          replayEntries[0]?.event.type === EventType.RUN_STARTED
        ) {
          return true;
        }

        const resumeRunId =
          resolvedRunId ??
          (replayEntries[0] ? getReplayEntryRunId(replayEntries[0]) : null);
        if (resumeRunId === null) {
          console.error(
            "[ag-ui] cursored resume cannot infer run id for synthetic RUN_STARTED",
            {
              threadId,
              threadChatId,
              firstType: replayEntries[0]?.event.type,
            },
          );
          const errorEvent = mapRunErrorToAgui(
            `Thread chat ${threadChatId} resume log is malformed: first event has no run id`,
            "replay_failed",
          );
          enqueue(encodeSseEvent(errorEvent));
          close("malformed_replay");
          return false;
        }

        resolvedRunId = resumeRunId;
        replayEntries.unshift({
          seq: null,
          event: buildResumeRunStartedEvent({
            threadId,
            runId: resumeRunId,
          }),
        });
        let syntheticFrameIsTerminal = false;
        for (let index = 1; index < replayEntries.length; index += 1) {
          const entry = replayEntries[index]!;
          const entryRunId = getReplayEntryRunId(entry);
          if (
            entry.event.type === EventType.RUN_STARTED &&
            entryRunId === resumeRunId
          ) {
            replayEntries.splice(index, 1);
            index -= 1;
            continue;
          }
          if (
            !syntheticFrameIsTerminal &&
            entry.event.type === EventType.RUN_STARTED &&
            entryRunId !== null &&
            entryRunId !== resumeRunId
          ) {
            replayEntries.splice(index, 0, {
              seq: null,
              event: {
                type: EventType.RUN_FINISHED,
                threadId,
                runId: resumeRunId,
              },
            });
            syntheticFrameIsTerminal = true;
            index += 1;
            continue;
          }
          if (
            entryRunId === resumeRunId &&
            isTerminalRunEventType(entry.event.type)
          ) {
            syntheticFrameIsTerminal = true;
          }
        }
        return true;
      };

      const replayDurableEventsAfterCursor = async (): Promise<boolean> => {
        let replayEnvelopes: AgUiEventEnvelope[];
        try {
          replayEnvelopes = await getAgUiEventEnvelopesForThreadChat({
            db,
            threadChatId,
            afterSeq: lastDeliveredSeq ?? undefined,
          });
        } catch (error) {
          console.warn(
            "[ag-ui] durable catch-up replay failed during live-tail; continuing",
            { threadId, threadChatId, runId: resolvedRunId },
            error,
          );
          return false;
        }

        if (replayEnvelopes.length === 0) {
          return false;
        }

        const replayEntries = toReplayEntries(replayEnvelopes, null);
        if (!frameResumeReplayEntries(replayEntries)) {
          return true;
        }
        const repairedReplayEntries =
          replayCursorSeq !== null && !hasEmittedAgUiDataEvent
            ? repairReplayTextMessageLifecycles(replayEntries)
            : replayEntries;
        let emittedReplayEntry = false;
        for (const entry of repairedReplayEntries) {
          if (!emitReplayEntry(entry)) {
            return true;
          }
          emittedReplayEntry = true;
          if (isTerminalRunEventType(entry.event.type)) {
            close("terminal_event");
            return true;
          }
        }
        return emittedReplayEntry;
      };

      // Shared live-tail helper: block-polls Redis starting from the cursor
      // captured before the DB replay. Used after both the run-replay path
      // (for active runs still in progress) and the no-history path (for
      // empty thread chats awaiting their first RUN_STARTED).
      const liveTail = async (params?: { runId?: string; userId?: string }) => {
        let liveTailParams = params;
        const localRedisHttpMode = isLocalRedisHttpMode();
        keepaliveTimer = setInterval(() => {
          enqueue(encodeSseComment("keepalive"));
        }, KEEPALIVE_INTERVAL_MS);

        const maybeReconcileActiveRunFromDurable = async (
          phase: "idle" | "xread_error",
          cause?: unknown,
        ): Promise<boolean> => {
          if (!liveTailParams?.runId || !liveTailParams.userId) {
            return false;
          }
          try {
            const runContext = await getAgentRunContextByRunId({
              db,
              runId: liveTailParams.runId,
              userId: liveTailParams.userId,
            });
            if (
              runContext !== null &&
              isTerminalAgentRunStatus(runContext.status)
            ) {
              await replayDurableEventsAfterCursor();
              if (closed) {
                return true;
              }
              const terminalEvent = buildRunTerminalAgUi({
                threadId,
                runId: liveTailParams.runId,
                daemonRunStatus: runContext.status,
                errorMessage: runContext.failureTerminalReason ?? null,
                errorCode: runContext.failureCategory ?? null,
              });
              if (!emitAgUiEvent(terminalEvent, null)) {
                return true;
              }
              close(
                phase === "idle"
                  ? "durable_terminal_idle"
                  : "durable_terminal_after_xread_error",
              );
              return true;
            }
            await replayDurableEventsAfterCursor();
            return closed;
          } catch (error) {
            console.warn(
              "[ag-ui] durable run status check failed during live-tail; continuing",
              { phase, threadId, threadChatId, runId: liveTailParams.runId },
              cause ?? error,
            );
          }
          return false;
        };

        const maybeDiscoverRunFromDurableLog = async (): Promise<boolean> => {
          if (liveTailParams?.runId) {
            return false;
          }
          let latestRunId: string | null = null;
          try {
            latestRunId = await getLatestRunIdForThreadChat({
              db,
              threadChatId,
            });
          } catch (error) {
            console.warn(
              "[ag-ui] latest-run discovery failed during empty live-tail; continuing",
              { threadId, threadChatId },
              error,
            );
            return false;
          }
          if (latestRunId === null) {
            return false;
          }

          resolvedRunId = latestRunId;
          const replayed = await replayDurableEventsAfterCursor();
          if (!closed) {
            liveTailParams = {
              runId: latestRunId,
              userId: session.user.id,
            };
          }
          return replayed;
        };

        let lastId = initialLastId;
        let consecutiveEmpty = 0;
        let emptyPollsSinceTerminalCheck = 0;
        while (!closed) {
          const adaptiveBlockMS = Math.min(
            MAX_XREAD_BLOCK_MS,
            MIN_XREAD_BLOCK_MS * (1 + consecutiveEmpty),
          );
          // Local redis-http transport has a tighter command-timeout budget than
          // production Upstash, so keep xread block windows short in dev to
          // avoid deterministic timeout/backoff loops.
          const blockMS = localRedisHttpMode
            ? MIN_XREAD_BLOCK_MS
            : adaptiveBlockMS;
          try {
            const raw = await redis.xread(streamKey, lastId, {
              count: XREAD_COUNT,
              blockMS,
            });
            if (closed) break;
            const entries = parseStreamEntries(raw);
            if (entries.length === 0) {
              consecutiveEmpty++;
              emptyPollsSinceTerminalCheck++;
              if (
                emptyPollsSinceTerminalCheck >=
                TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS
              ) {
                emptyPollsSinceTerminalCheck = 0;
                if (!liveTailParams?.runId) {
                  await maybeDiscoverRunFromDurableLog();
                } else if (liveTailParams.userId) {
                  if (await maybeReconcileActiveRunFromDurable("idle")) {
                    break;
                  }
                }
              }
            } else {
              consecutiveEmpty = 0;
              emptyPollsSinceTerminalCheck = 0;
              for (const entry of entries) {
                lastId = entry.id;
                if (entry.event != null) {
                  if (
                    entry.seq !== null &&
                    !shouldReplayEnvelope(
                      {
                        seq: entry.seq,
                        projectionIndex: entry.identity?.projectionIndex,
                      },
                      replayCursor,
                    )
                  ) {
                    diagnostics.dedupeCount += 1;
                    continue;
                  }
                  // Replay and live-tail intentionally overlap during connect so
                  // we do not drop events written mid-replay. Skip the first
                  // matching live event if it was already emitted from replay.
                  if (
                    consumeReplayedEventDedupeKey(entry.event, entry.identity)
                  ) {
                    diagnostics.dedupeCount += 1;
                    continue;
                  }
                  if (entry.seq !== null) {
                    lastDeliveredSeq =
                      lastDeliveredSeq === null
                        ? entry.seq
                        : Math.max(lastDeliveredSeq, entry.seq);
                  }
                  if (!emitAgUiEvent(entry.event, entry.seq, entry.identity)) {
                    return;
                  }
                  if (isTerminalRunEventType(entry.event.type)) {
                    close("terminal_event");
                    return;
                  }
                }
              }
            }
          } catch (error) {
            if (closed) break;
            // Reset adaptive growth on transport failures so the next read
            // re-enters with the smallest block window.
            consecutiveEmpty = 0;
            diagnostics.xreadErrorCount += 1;
            diagnostics.xreadBackoffCount += 1;
            if (isXreadTimeoutError(error)) {
              diagnostics.xreadTimeoutCount += 1;
            }
            const shouldLogXreadError =
              diagnostics.xreadErrorCount <= XREAD_ERROR_LOG_INITIAL_BUDGET ||
              diagnostics.xreadErrorCount % XREAD_ERROR_LOG_EVERY_N === 0;
            if (shouldLogXreadError) {
              console.warn(
                "[ag-ui] XREAD failed, backing off",
                {
                  streamKey,
                  xreadErrorCount: diagnostics.xreadErrorCount,
                  xreadTimeoutCount: diagnostics.xreadTimeoutCount,
                  xreadBackoffCount: diagnostics.xreadBackoffCount,
                },
                error,
              );
            }
            emptyPollsSinceTerminalCheck++;
            if (
              emptyPollsSinceTerminalCheck >=
              TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS
            ) {
              emptyPollsSinceTerminalCheck = 0;
              if (!liveTailParams?.runId) {
                await maybeDiscoverRunFromDurableLog();
              } else if (liveTailParams.userId) {
                if (
                  await maybeReconcileActiveRunFromDurable("xread_error", error)
                ) {
                  break;
                }
              }
            }
            await new Promise((resolve) =>
              setTimeout(resolve, XREAD_BACKOFF_MS),
            );
          }
        }
      };

      // -----------------------------------------------------------------
      // Path A: fresh connect against a thread chat with no runs yet.
      // Send an immediate keepalive comment so proxies don't close idle
      // connections before the first real event lands, then live-tail.
      // -----------------------------------------------------------------
      if (resolvedRunId === null) {
        const replayed =
          replayCursorSeq !== null
            ? await replayDurableEventsAfterCursor()
            : false;
        if (closed) {
          return;
        }
        if (!replayed) {
          enqueue(encodeSseComment("awaiting-first-run"));
        }
        await liveTail(
          resolvedRunId !== null
            ? { runId: resolvedRunId, userId: session.user.id }
            : undefined,
        );
        return;
      }

      // -----------------------------------------------------------------
      // Path B: replay the thread chat's full AG-UI event log, then
      // live-tail if the latest/explicit run is still active. Replay is
      // threadChat-scoped so reconnects can hydrate prior runs without
      // going back through the DB-message transcript path.
      // -----------------------------------------------------------------
      let replayEnvelopes: AgUiEventEnvelope[];
      try {
        replayEnvelopes =
          resolvedRunId !== null && replayCursorSeq === null
            ? await getAgUiEventEnvelopesForRun({
                db,
                runId: resolvedRunId,
                threadChatId,
              })
            : await getAgUiEventEnvelopesForThreadChat({
                db,
                threadChatId,
                afterSeq: replayQueryAfterSeq(replayCursor),
              });
      } catch (error) {
        console.error(
          "[ag-ui] threadChat replay failed",
          { threadId, threadChatId, runId: resolvedRunId },
          error,
        );
        const errorEvent = mapRunErrorToAgui(
          error instanceof Error ? error.message : "Replay failed",
          "replay_failed",
        );
        enqueue(encodeSseEvent(errorEvent));
        close("replay_failed");
        return;
      }

      let terminalRunContext: Awaited<
        ReturnType<typeof getAgentRunContextByRunId>
      > = null;
      if (resolvedRunId !== null) {
        try {
          terminalRunContext = await getAgentRunContextByRunId({
            db,
            runId: resolvedRunId,
            userId: session.user.id,
          });
        } catch (error) {
          console.warn(
            "[ag-ui] run context lookup failed; continuing without durable terminal fallback",
            {
              threadId,
              threadChatId,
              runId: resolvedRunId,
            },
            error,
          );
        }
      }

      if (replayEnvelopes.length === 0) {
        if (
          replayCursorSeq !== null &&
          resolvedRunId !== null &&
          terminalRunContext !== null &&
          !isTerminalAgentRunStatus(terminalRunContext.status)
        ) {
          if (shouldFrameRunAgentResume) {
            const runStartedEvent = buildResumeRunStartedEvent({
              threadId,
              runId: resolvedRunId,
            });
            rememberReplayedEventDedupeKeys(runStartedEvent);
            emitAgUiEvent(runStartedEvent, null);
          }
          await liveTail({ runId: resolvedRunId, userId: session.user.id });
          return;
        }
        if (
          replayCursorSeq !== null &&
          terminalRunContext !== null &&
          isTerminalAgentRunStatus(terminalRunContext.status)
        ) {
          close("replay_already_terminal");
          return;
        }
        const errorEvent = mapRunErrorToAgui(
          `Thread chat ${threadChatId} has no AG-UI events after cursor ${replayCursorSeq ?? "start"}`,
          "run_not_found",
        );
        enqueue(encodeSseEvent(errorEvent));
        close("run_not_found");
        return;
      }

      const {
        hasTerminalEvent: resolvedRunHasTerminalEvent,
        syntheticTerminalEntry,
      } = synthesizeTerminalEntry({
        runId: resolvedRunId,
        envelopes: replayEnvelopes,
        runContext: terminalRunContext,
        threadId,
      });

      const historyPrefix =
        replayCursorSeq === null
          ? splitHistoryOnlyPrefix(replayEnvelopes)
          : { historyOnlyLastSeq: null, replayEnvelopes };
      const streamReplayEnvelopes = historyPrefix.replayEnvelopes;
      if (historyPrefix.historyOnlyLastSeq !== null) {
        lastDeliveredSeq =
          lastDeliveredSeq === null
            ? historyPrefix.historyOnlyLastSeq
            : Math.max(lastDeliveredSeq, historyPrefix.historyOnlyLastSeq);
      }

      if (replayCursorSeq === null && streamReplayEnvelopes.length === 0) {
        enqueue(encodeSseComment("awaiting-first-run"));
        await liveTail();
        return;
      }

      const replayEntries = toReplayEntries(
        streamReplayEnvelopes,
        replayCursor,
      );

      if (replayCursorSeq === null) {
        // Contract: a complete thread-chat replay MUST start with
        // RUN_STARTED after any history-only message snapshots. Cursored
        // reconnects may legitimately start in the middle of a run.
        if (replayEntries[0]?.event.type !== EventType.RUN_STARTED) {
          console.error(
            "[ag-ui] threadChat replay: first event was not RUN_STARTED",
            {
              threadId,
              threadChatId,
              runId: resolvedRunId,
              firstType: replayEntries[0]?.event.type,
            },
          );
          const errorEvent = mapRunErrorToAgui(
            `Thread chat ${threadChatId} log is malformed: first event is ${replayEntries[0]?.event.type ?? "empty"}, expected RUN_STARTED`,
            "replay_failed",
          );
          enqueue(encodeSseEvent(errorEvent));
          close("malformed_replay");
          return;
        }
      }

      if (
        replayCursorSeq !== null &&
        !frameResumeReplayEntries(replayEntries)
      ) {
        return;
      }
      const streamReplayEntries =
        replayCursorSeq !== null
          ? repairReplayTextMessageLifecycles(replayEntries)
          : replayEntries;
      if (syntheticTerminalEntry !== null) {
        streamReplayEntries.push(syntheticTerminalEntry);
      }

      const isRunComplete =
        resolvedRunHasTerminalEvent || syntheticTerminalEntry !== null;

      for (const entry of streamReplayEntries) {
        if (!emitReplayEntry(entry)) {
          return;
        }
      }

      if (isRunComplete) {
        // The run already terminated before connect. Close the stream so
        // the client's SSE consumer knows the server has nothing more to
        // say. Live-tail here would block on an XREAD poll forever
        // without producing useful output.
        close("replay_already_terminal");
        return;
      }

      await liveTail({ runId: resolvedRunId, userId: session.user.id });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// POST: client-initiated runs.
// HttpAgent POSTs RunAgentInput; we extract the new user message + metadata,
// call followUp() via dispatchFollowUpFromAppend, then fall through to the SSE
// stream machinery shared with GET. The advisory lock in the adapter holds
// the dedup invariant (see ADR docs/plans/2026-04-30-runtime-owns-writes-adr.md).
//
// Replay mode (header X-Terragon-Test-Replay): adapter skips, request streams
// as today. Preserves integration-harness fixture validity.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  // 1. Resolve threadId from params
  const { threadId } = await ctx.params;

  // 2. Authenticate — same path as GET
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // 3. Resolve threadChatId from URL query param
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");
  if (!threadChatId) {
    return NextResponse.json(
      { error: "Missing threadChatId" },
      { status: 400 },
    );
  }

  // 4. Detect replay mode via header X-Terragon-Test-Replay (any truthy value)
  const isReplayMode = !!request.headers.get("X-Terragon-Test-Replay");

  // 5. Dispatch new append POSTs; resume/back-compat requests fall through to SSE.
  const commandResult = await handleAgUiPostCommand({
    request,
    threadId,
    threadChatId,
    userId,
    isReplayMode,
  });
  if (commandResult.type === "response") {
    return NextResponse.json(commandResult.body, {
      status: commandResult.status,
    });
  }

  // 6. Fall through: open the SSE stream via the existing GET handler
  return GET(request, ctx);
}
