import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  EventType,
  type BaseEvent,
  type RunStartedEvent,
  type TextMessageStartEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import * as schema from "@terragon/shared/db/schema";
import {
  agUiStreamKey,
  getActiveAgUiLifecycleAt,
  getAgUiEventsForReplay,
} from "@terragon/shared/model/agent-event-log";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

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

const ENCODER = new TextEncoder();

type AgUiStreamEntry = {
  id: string;
  event: BaseEvent | null;
};

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
      const parsed = JSON.parse(serialized) as BaseEvent;
      entries.push({ id, event: parsed });
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
  const fromSeqStr = request.nextUrl.searchParams.get("fromSeq");

  if (!threadChatId) {
    return NextResponse.json(
      { error: "Missing threadChatId" },
      { status: 400 },
    );
  }

  if (fromSeqStr == null) {
    return NextResponse.json(
      { error: "Missing replay cursor (fromSeq)" },
      { status: 400 },
    );
  }
  const fromSeq = Number(fromSeqStr);
  if (!Number.isInteger(fromSeq) || fromSeq < 0) {
    return NextResponse.json({ error: "Invalid fromSeq" }, { status: 400 });
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
  // the at-least-once contract: client will receive all events with
  // seq > fromSeq (via DB replay) plus any new stream entries from this
  // cursor onward. Some duplicates are acceptable — AG-UI is designed to
  // de-dupe by event identity on the client.
  const initialLastId = await captureStreamCursor(streamKey);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let keepaliveTimer: NodeJS.Timeout | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // controller closed
          closed = true;
        }
      };

      // Tear down on client abort. `once: true` handles listener cleanup.
      const abortSignal = request.signal;
      if (abortSignal.aborted) {
        close();
        return;
      }
      abortSignal.addEventListener("abort", () => close(), { once: true });

      // 1) Load the stored replay FIRST so we can inspect whether it already
      // contains a real RUN_STARTED event. The AG-UI client's verifier (see
      // `L=` in @ag-ui/client/dist/index.mjs) tracks per-run state with a
      // `runStarted` flag that is only cleared by RUN_FINISHED. Emitting a
      // synthetic RUN_STARTED followed by a real one from the log causes the
      // verifier to throw:
      //     Cannot send 'RUN_STARTED' while a run is still active. The
      //     previous run must be finished with 'RUN_FINISHED' before
      //     starting a new run.
      //
      // The verifier's state is per-runAgent-invocation (fresh on each
      // SSE connect — it closes over local `let p=!1,s=!1,...`), so there
      // is no cross-stream state to worry about. The only way to trigger
      // the "still active" error within a single stream is to emit two
      // RUN_STARTEDs before a RUN_FINISHED. Skip the synthetic prepend
      // when the replay window already contains a real RUN_STARTED; the
      // log's natural bracket covers it.
      let replay: BaseEvent[];
      try {
        replay = await getAgUiEventsForReplay({
          db,
          threadChatId,
          fromSeq,
        });
      } catch (error) {
        console.error(
          "[ag-ui] replay burst failed",
          { threadId, threadChatId, fromSeq },
          error,
        );
        // The route's error path must still satisfy the verifier's
        // "first event must be RUN_STARTED or RUN_ERROR" rule. RUN_ERROR
        // alone is accepted as the first event.
        const errorEvent = mapRunErrorToAgui(
          error instanceof Error ? error.message : "Replay failed",
          "replay_failed",
        );
        enqueue(encodeSseEvent(errorEvent));
        close();
        return;
      }

      const replayHasRunStarted = replay.some(
        (event) => event.type === EventType.RUN_STARTED,
      );

      // 2) Prepend a synthetic RUN_STARTED ONLY when the replay doesn't
      // already contain one. This covers:
      //   - Mid-run reconnects (fromSeq > 0 and the original RUN_STARTED
      //     has already been consumed by the client in an earlier stream).
      //   - Replay windows trimmed at the head so no RUN_STARTED remains.
      // The AG-UI client protocol requires every SSE stream to begin with
      // RUN_STARTED to establish run context. This synthetic event is
      // per-connection and not persisted.
      if (!replayHasRunStarted) {
        const syntheticRunStarted: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          timestamp: Date.now(),
          threadId: threadChatId,
          runId: `resume-${threadChatId}-${Date.now()}`,
        };
        enqueue(encodeSseEvent(syntheticRunStarted));
      }

      // 3) If reconnecting mid-turn (fromSeq > 0), re-emit synthetic
      // TEXT_MESSAGE_START / TOOL_CALL_START events for any lifecycle still
      // "active" at the cursor (STARTed in the pre-cursor history but not
      // ENDed). Without these, subsequent TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS
      // events from the `seq > fromSeq` replay reference IDs the client's
      // reducer has never seen and are rejected with an AGUIError.
      //
      // Limitation: TOOL_CALL_ARGS accumulated pre-cursor are not
      // reconstructed. The client's args buffer will start empty; if the
      // end-of-call is also pre-cursor this is fine, but for an in-flight
      // call partial args are lost. Acceptable for now — args are usually
      // emitted as a single batch at end-of-call.
      //
      // These synthetic events are per-connection and NOT persisted.
      try {
        const active = await getActiveAgUiLifecycleAt({
          db,
          threadChatId,
          fromSeq,
        });
        const replayStartTimestamp = Date.now();
        for (const { messageId } of active.textMessages) {
          const startEvent: TextMessageStartEvent = {
            type: EventType.TEXT_MESSAGE_START,
            timestamp: replayStartTimestamp,
            messageId,
            role: "assistant",
          } as TextMessageStartEvent;
          enqueue(encodeSseEvent(startEvent));
        }
        for (const { toolCallId, toolCallName } of active.toolCalls) {
          const startEvent: ToolCallStartEvent = {
            type: EventType.TOOL_CALL_START,
            timestamp: replayStartTimestamp,
            toolCallId,
            toolCallName,
          } as ToolCallStartEvent;
          enqueue(encodeSseEvent(startEvent));
        }
      } catch (error) {
        // Active-state reconstruction is best-effort: if it fails, log and
        // continue with the normal replay. Worst case the client will
        // reject a few CONTENT events — same outcome as pre-fix — but we
        // don't take down the whole stream over a lifecycle-scan hiccup.
        console.warn(
          "[ag-ui] active-state reconstruction failed; continuing without synthetic STARTs",
          { threadId, threadChatId, fromSeq },
          error,
        );
      }

      // 4) Flush the replay burst we loaded at step 1.
      for (const event of replay) {
        enqueue(encodeSseEvent(event));
      }

      // 4) Keepalive pings so proxies don't close idle connections.
      keepaliveTimer = setInterval(() => {
        enqueue(encodeSseComment("keepalive"));
      }, KEEPALIVE_INTERVAL_MS);

      // 5) Live tail via XREAD, starting from the cursor captured BEFORE
      // the DB replay query so nothing XADD'd during replay is lost.
      // Task 2C publishes to this stream with
      // XADD `${streamKey} * event <json>`.
      // TODO(2C): integration coverage of the live tail lives with the
      // writer work; the subscribe path here is intentionally shape-compatible
      // with that contract but not exercised by unit tests.
      let lastId = initialLastId;
      let consecutiveEmpty = 0;
      while (!closed) {
        // Linear growth from MIN → MAX: 2s, 4s, 6s, 8s, 10s, 10s, …
        const blockMS = Math.min(
          MAX_XREAD_BLOCK_MS,
          MIN_XREAD_BLOCK_MS * (1 + consecutiveEmpty),
        );
        try {
          const raw = await redis.xread(streamKey, lastId, {
            count: XREAD_COUNT,
            blockMS,
          });
          if (closed) break;
          const entries = parseStreamEntries(raw);
          if (entries.length === 0) {
            consecutiveEmpty++;
          } else {
            consecutiveEmpty = 0;
            for (const entry of entries) {
              lastId = entry.id;
              if (entry.event != null) {
                enqueue(encodeSseEvent(entry.event));
              }
            }
          }
        } catch (error) {
          if (closed) break;
          console.warn(
            "[ag-ui] XREAD failed, backing off",
            { streamKey },
            error,
          );
          await new Promise((resolve) => setTimeout(resolve, XREAD_BACKOFF_MS));
        }
      }
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
//   1. All cursor state lives in query params (threadChatId, fromSeq),
//      which are on the URL for both methods.
//   2. Backend run state is authoritative; client-provided run input is
//      discarded here. Runs are initiated via server actions (followUp,
//      retry, etc.), not by the client's runAgent POST. The POST body
//      is the ceremony that opens the SSE stream.
export const POST = GET;
