import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import type { BaseEvent } from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import * as schema from "@terragon/shared/db/schema";
import {
  agUiStreamKey,
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

// XREAD poll tuning. blockMS is capped by the resilient-redis client's
// localHttpCommandTimeoutMs (3_000) in dev, so we stay under that to
// avoid noisy "Local redis-http command timeout" warnings. Production
// Upstash has a higher ceiling; 2s is conservative everywhere.
const XREAD_BLOCK_MS = 2_000;
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

      // 1) Initial replay burst from agent_event_log.
      try {
        const replay = await getAgUiEventsForReplay({
          db,
          threadChatId,
          fromSeq,
        });
        for (const event of replay) {
          enqueue(encodeSseEvent(event));
        }
      } catch (error) {
        console.error(
          "[ag-ui] replay burst failed",
          { threadId, threadChatId, fromSeq },
          error,
        );
        const errorEvent = mapRunErrorToAgui(
          error instanceof Error ? error.message : "Replay failed",
          "replay_failed",
        );
        enqueue(encodeSseEvent(errorEvent));
        close();
        return;
      }

      // 2) Keepalive pings so proxies don't close idle connections.
      keepaliveTimer = setInterval(() => {
        enqueue(encodeSseComment("keepalive"));
      }, KEEPALIVE_INTERVAL_MS);

      // 3) Live tail via XREAD, starting from the cursor captured BEFORE
      // the DB replay query so nothing XADD'd during replay is lost.
      // Task 2C publishes to this stream with
      // XADD `${streamKey} * event <json>`.
      // TODO(2C): integration coverage of the live tail lives with the
      // writer work; the subscribe path here is intentionally shape-compatible
      // with that contract but not exercised by unit tests.
      let lastId = initialLastId;
      while (!closed) {
        try {
          const raw = await redis.xread(streamKey, lastId, {
            count: XREAD_COUNT,
            blockMS: XREAD_BLOCK_MS,
          });
          if (closed) break;
          const entries = parseStreamEntries(raw);
          for (const entry of entries) {
            lastId = entry.id;
            if (entry.event != null) {
              enqueue(encodeSseEvent(entry.event));
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
