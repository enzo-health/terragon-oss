import { type BaseEvent, EventType } from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import * as schema from "@terragon/shared/db/schema";
import {
  agUiStreamKey,
  getAgUiEventsForRun,
  getLatestRunIdForThreadChat,
  isTerminalAgentRunStatus,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isLocalRedisHttpMode, redis } from "@/lib/redis";
import { buildRunTerminalAgUi } from "@/server-lib/ag-ui-publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-lived SSE stream: request up to 5 minutes of serverless execution
// time (Vercel Pro cap). Client-side aborts close the stream early, so
// typical usage will not hit this ceiling.
export const maxDuration = 300;

// XREAD poll tuning. Adaptive backoff: start at MIN_XREAD_BLOCK_MS and
// grow linearly up to MAX_XREAD_BLOCK_MS while the stream is idle, then
// reset on any received event. This cuts Upstash read costs on long-idle
// SSE streams without trading off live-tail latency on active threads.
//
// Note: production Upstash HTTP timeout permits up to ~30s block windows;
// dev's resilient-redis client caps at ~3s (localHttpCommandTimeoutMs)
// so the MIN value stays under that ceiling to avoid noisy warnings.
const MIN_XREAD_BLOCK_MS = 2_000;
const MAX_XREAD_BLOCK_MS = 10_000;
const XREAD_COUNT = 32;
const KEEPALIVE_INTERVAL_MS = 15_000;
const XREAD_BACKOFF_MS = 1_000;
const BASELINE_SNAPSHOT_COMMENT = "baseline-snapshot";
// When Redis live-tail misses the daemon's terminal marker, we still need to
// converge on terminal truth once durable run status flips. Tie checks to idle
// polls (not wall-clock time) so tests stay deterministic.
const TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS = 2;

const ENCODER = new TextEncoder();
const AG_UI_EVENT_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(EventType),
);

type AgUiStreamEntry = {
  id: string;
  event: BaseEvent | null;
};

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const serializedEntries = entries.map(
    ([key, entryValue]) =>
      `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
  );
  return `{${serializedEntries.join(",")}}`;
}

function getReplayDedupeKey(event: BaseEvent): string {
  return stableSerialize(event);
}

const STREAM_LOG_PREFIX = "[ag-ui][stream]";
const XREAD_ERROR_LOG_INITIAL_BUDGET = 3;
const XREAD_ERROR_LOG_EVERY_N = 20;

type StreamCloseReason =
  | "client_abort_before_start"
  | "client_abort"
  | "controller_enqueue_failed"
  | "durable_terminal_idle"
  | "durable_terminal_after_xread_error"
  | "terminal_event"
  | "replay_failed"
  | "run_not_found"
  | "malformed_replay"
  | "replay_already_terminal";

type StreamDiagnostics = {
  openedAtMs: number;
  firstFrameLatencyMs: number | null;
  replayCount: number;
  dedupeCount: number;
  xreadTimeoutCount: number;
  xreadBackoffCount: number;
  xreadErrorCount: number;
};

function isXreadTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("local redis-http command timeout") ||
    message.includes("timeout") ||
    message.includes("time out")
  );
}

function emitStreamDiagnostic(
  event: "stream_open" | "first_frame" | "stream_close",
  payload: Record<string, unknown>,
): void {
  console.info(STREAM_LOG_PREFIX, {
    event,
    ...payload,
  });
}

function isTerminalRunEventType(type: BaseEvent["type"]): boolean {
  return type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR;
}

function isAgUiBaseEvent(value: unknown): value is BaseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return AG_UI_EVENT_TYPES.has(Reflect.get(value, "type"));
}

function parseStreamEntries(raw: unknown): AgUiStreamEntry[] {
  // XREAD shape: [ [streamKey, [ [id, [field, value, ...]], ... ]] ] or null.
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const firstStream = raw[0];
  if (!Array.isArray(firstStream) || firstStream.length < 2) {
    return [];
  }
  const rawEntries = firstStream[1];
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const entries: AgUiStreamEntry[] = [];
  for (const entry of rawEntries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const [id, rawFields] = entry;
    if (typeof id !== "string") {
      continue;
    }
    const serialized = readEventField(rawFields);
    if (serialized == null) {
      entries.push({ id, event: null });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      entries.push({ id, event: isAgUiBaseEvent(parsed) ? parsed : null });
    } catch (err) {
      console.warn("[ag-ui] malformed stream entry", { id, err });
      entries.push({ id, event: null });
    }
  }
  return entries;
}

function readEventField(rawFields: unknown): string | null {
  if (!Array.isArray(rawFields)) {
    // Upstash sometimes returns an object shape already parsed.
    if (rawFields && typeof rawFields === "object") {
      const value = Reflect.get(rawFields, "event");
      return typeof value === "string" ? value : null;
    }
    return null;
  }
  for (let i = 0; i < rawFields.length; i += 2) {
    if (rawFields[i] === "event" && typeof rawFields[i + 1] === "string") {
      return rawFields[i + 1] as string;
    }
  }
  return null;
}

function encodeSseEvent(event: BaseEvent): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function encodeSseComment(comment: string): Uint8Array {
  return ENCODER.encode(`: ${comment}\n\n`);
}

/**
 * Capture the stream's current last ID BEFORE the DB replay query so that
 * events XADD'd while the replay is in flight are not dropped by the live
 * tail's `$` cursor. Empty/missing streams fall back to `"0"` so the first
 * XREAD picks up any entry published after this moment.
 */
async function captureStreamCursor(streamKey: string): Promise<string> {
  try {
    const latest = await redis.xrevrange(streamKey, "+", "-", 1);
    if (latest && typeof latest === "object") {
      const ids = Object.keys(latest);
      if (ids.length > 0 && typeof ids[0] === "string") {
        return ids[0]!;
      }
    }
    return "0";
  } catch (err) {
    console.warn("[ag-ui] captureStreamCursor failed; falling back to 0", {
      streamKey,
      err,
    });
    return "0";
  }
}

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
  const ownership = await db
    .select({ id: schema.threadChat.id })
    .from(schema.threadChat)
    .innerJoin(schema.thread, eq(schema.threadChat.threadId, schema.thread.id))
    .where(
      and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, session.user.id),
      ),
    )
    .limit(1);

  if (ownership.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  //  - Otherwise the connect is fresh; default to the thread chat's latest
  //    run. Clients that land on an empty thread chat (no runs yet) get a
  //    live-tailing stream with no history — the first RUN_STARTED written
  //    by a new daemon-event will naturally be the first event on the wire,
  //    no synthesis required.
  let resolvedRunId: string | null = runIdParam;
  if (resolvedRunId === null) {
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
      // Snapshot-first framing contract: always emit a baseline marker before
      // replay or live-tail frames so clients can align first-paint lifecycle.
      enqueue(encodeSseComment(BASELINE_SNAPSHOT_COMMENT));

      // Shared live-tail helper: block-polls Redis starting from the cursor
      // captured before the DB replay. Used after both the run-replay path
      // (for active runs still in progress) and the no-history path (for
      // empty thread chats awaiting their first RUN_STARTED).
      const liveTail = async (params?: { runId?: string; userId?: string }) => {
        const localRedisHttpMode = isLocalRedisHttpMode();
        keepaliveTimer = setInterval(() => {
          enqueue(encodeSseComment("keepalive"));
        }, KEEPALIVE_INTERVAL_MS);

        const maybeEmitTerminalFromDurable = async (
          phase: "idle" | "xread_error",
          cause?: unknown,
        ): Promise<boolean> => {
          if (!params?.runId || !params.userId) {
            return false;
          }
          try {
            const runContext = await getAgentRunContextByRunId({
              db,
              runId: params.runId,
              userId: params.userId,
            });
            if (
              runContext !== null &&
              isTerminalAgentRunStatus(runContext.status)
            ) {
              const terminalEvent = buildRunTerminalAgUi({
                threadId,
                runId: params.runId,
                daemonRunStatus: runContext.status,
                errorMessage: runContext.failureTerminalReason ?? null,
                errorCode: runContext.failureCategory ?? null,
              });
              enqueue(encodeSseEvent(terminalEvent));
              close(
                phase === "idle"
                  ? "durable_terminal_idle"
                  : "durable_terminal_after_xread_error",
              );
              return true;
            }
          } catch (error) {
            console.warn(
              "[ag-ui] durable run status check failed during live-tail; continuing",
              { phase, threadId, threadChatId, runId: params.runId },
              cause ?? error,
            );
          }
          return false;
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
              if (params?.runId && params.userId) {
                emptyPollsSinceTerminalCheck++;
                if (
                  emptyPollsSinceTerminalCheck >=
                  TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS
                ) {
                  emptyPollsSinceTerminalCheck = 0;
                  if (await maybeEmitTerminalFromDurable("idle")) {
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
                  // Replay and live-tail intentionally overlap during connect so
                  // we do not drop events written mid-replay. Skip the first
                  // matching live event if it was already emitted from replay.
                  const dedupeKey = getReplayDedupeKey(entry.event);
                  if (replayedEventDedupeKeys.has(dedupeKey)) {
                    replayedEventDedupeKeys.delete(dedupeKey);
                    diagnostics.dedupeCount += 1;
                    continue;
                  }
                  enqueue(encodeSseEvent(entry.event));
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
            if (params?.runId && params.userId) {
              emptyPollsSinceTerminalCheck++;
              if (
                emptyPollsSinceTerminalCheck >=
                TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS
              ) {
                emptyPollsSinceTerminalCheck = 0;
                if (await maybeEmitTerminalFromDurable("xread_error", error)) {
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
        enqueue(encodeSseComment("awaiting-first-run"));
        await liveTail();
        return;
      }

      // -----------------------------------------------------------------
      // Path B: replay the resolved run's full event log, then live-tail
      // if the run is still active. The events query naturally begins
      // with the real RUN_STARTED for that run, so no synthesis is
      // required.
      // -----------------------------------------------------------------
      let runEvents: BaseEvent[];
      try {
        runEvents = await getAgUiEventsForRun({
          db,
          runId: resolvedRunId,
          threadChatId,
        });
      } catch (error) {
        console.error(
          "[ag-ui] runId replay failed",
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
      if (runEvents.length > 0) {
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

      // Caller-supplied runId that doesn't exist in this thread chat:
      // emit a RUN_ERROR rather than 404ing. The client sees a
      // protocol-valid first event and can react via its existing
      // error-handler plumbing.
      if (runEvents.length === 0) {
        const errorEvent = mapRunErrorToAgui(
          `Run ${resolvedRunId} has no events for thread chat ${threadChatId}`,
          "run_not_found",
        );
        enqueue(encodeSseEvent(errorEvent));
        close("run_not_found");
        return;
      }

      const runHasTerminalEvent = runEvents.some(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      );

      if (
        !runHasTerminalEvent &&
        terminalRunContext !== null &&
        isTerminalAgentRunStatus(terminalRunContext.status)
      ) {
        const terminalEvent = buildRunTerminalAgUi({
          threadId,
          runId: resolvedRunId,
          daemonRunStatus: terminalRunContext.status,
          errorMessage: terminalRunContext.failureTerminalReason ?? null,
          errorCode: terminalRunContext.failureCategory ?? null,
        });
        runEvents = [...runEvents, terminalEvent];
      }

      // Contract: events for a run MUST start with RUN_STARTED. If not,
      // surface loudly — the fix lives in the writer, not here.
      if (runEvents[0]?.type !== EventType.RUN_STARTED) {
        console.error("[ag-ui] runId replay: first event was not RUN_STARTED", {
          threadId,
          threadChatId,
          runId: resolvedRunId,
          firstType: runEvents[0]?.type,
        });
        const errorEvent = mapRunErrorToAgui(
          `Run ${resolvedRunId} log is malformed: first event is ${runEvents[0]?.type ?? "empty"}, expected RUN_STARTED`,
          "replay_failed",
        );
        enqueue(encodeSseEvent(errorEvent));
        close("malformed_replay");
        return;
      }

      const isRunComplete = runEvents.some(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      );

      for (const event of runEvents) {
        diagnostics.replayCount += 1;
        replayedEventDedupeKeys.add(getReplayDedupeKey(event));
        enqueue(encodeSseEvent(event));
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

// AG-UI's HttpAgent POSTs RunAgentInput to the run URL. We route through
// the same SSE handler because:
//   1. All cursor state lives in query params (threadChatId, runId),
//      which are on the URL for both methods.
//   2. Backend run state is authoritative; client-provided run input is
//      discarded here. Runs are initiated via server actions (followUp,
//      retry, etc.), not by the client's runAgent POST. The POST body
//      is the ceremony that opens the SSE stream.
export const POST = GET;
