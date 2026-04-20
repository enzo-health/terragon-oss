import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import type { BaseEvent } from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import * as schema from "@terragon/shared/db/schema";
import { getAgUiEventsForReplay } from "@terragon/shared/model/agent-event-log";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Redis stream key used for the live tail. Task 2C will publish AG-UI
// BaseEvent payloads as JSON strings on this key (field `event`).
// The SSE endpoint polls the stream via XREAD with blockMS.
function agUiStreamKey(threadChatId: string): string {
  return `agui:thread:${threadChatId}`;
}

// XREAD poll tuning. blockMS on Upstash caps the HTTP wait; we loop so the
// endpoint can honor request.signal aborts and emit keepalives on idle.
const XREAD_BLOCK_MS = 5_000;
const XREAD_COUNT = 32;
const KEEPALIVE_INTERVAL_MS = 15_000;

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
    } catch {
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
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function encodeSseComment(comment: string): Uint8Array {
  return new TextEncoder().encode(`: ${comment}\n\n`);
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
  const fromSeq = parseInt(fromSeqStr, 10);
  if (!Number.isFinite(fromSeq) || fromSeq < 0) {
    return NextResponse.json({ error: "Invalid fromSeq" }, { status: 400 });
  }

  // Verify thread ownership — return 404 for mismatches so unauthorized
  // access can't distinguish "thread doesn't exist" from "not yours".
  const thread = await db
    .select({ id: schema.thread.id })
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, session.user.id),
      ),
    )
    .limit(1);

  if (thread.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const streamKey = agUiStreamKey(threadChatId);

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

      // Tear down on client abort.
      const abortSignal = request.signal;
      const onAbort = () => close();
      if (abortSignal.aborted) {
        close();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });

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

      // 3) Live tail via XREAD. Poll in a loop so aborts are responsive.
      // Start from "$" = only messages newer than the current end-of-stream.
      // Task 2C will be responsible for publishing to this stream with
      // XADD `${streamKey} * event <json>`.
      // TODO(2C): integration coverage of the live tail lives with the
      // writer work; the subscribe path here is intentionally shape-compatible
      // with that contract but not exercised by unit tests.
      let lastId = "$";
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
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }

      abortSignal.removeEventListener("abort", onAbort);
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
