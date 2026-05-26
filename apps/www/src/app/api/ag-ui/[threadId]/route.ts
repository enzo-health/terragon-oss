import { RunAgentInputSchema } from "@ag-ui/core";
import { NextRequest, NextResponse } from "next/server";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";
import {
  agUiStreamKey,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getTraceIdFromAgUiForwardedProps,
  recordAgentTraceSpan,
} from "@/lib/agent-trace";
import { runFollowUpFromAgUiInput } from "@/server-lib/run-from-ag-ui";
import {
  captureStreamCursor,
  createAgUiStream,
  getAgUiHistoryMessages,
  readTerragonPostIntent,
  resolveReplayCursor,
} from "@/server-lib/ag-ui-stream-service";

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
  const replayCursor = resolveReplayCursor(request);
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
  const ownership = await db
    .select({
      id: schema.threadChat.id,
      messages: schema.threadChat.messages,
    })
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

  if (request.nextUrl.searchParams.get("history") === "messages") {
    const result = await getAgUiHistoryMessages({
      threadChatId,
      dbMessages: ownership[0]?.messages ?? [],
    });
    return NextResponse.json(result);
  }

  // Eagerly resolve the effective runId and capture the Redis stream cursor
  // BEFORE creating the stream body. Tests assert these DB/Redis helpers are
  // called during the synchronous request handler, before any body read.
  let resolvedRunId: string | null = runIdParam;
  const replayCursorSeq = replayCursor?.seq ?? null;
  if (resolvedRunId === null && replayCursorSeq === null) {
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

  const streamKey = agUiStreamKey(threadChatId);
  const initialLastId = await captureStreamCursor(streamKey);

  const stream = createAgUiStream({
    threadId,
    threadChatId,
    runIdParam,
    replayCursor,
    shouldFrameRunAgentResume,
    requestSignal: request.signal,
    userId: session.user.id,
    dbMessages: ownership[0]?.messages ?? [],
    resolvedRunId,
    initialLastId,
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
// call followUp() via runFollowUpFromAgUiInput, then fall through to the SSE
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

  // 5. Parse the request body as RunAgentInput (skip in replay mode)
  if (!isReplayMode) {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // Body parse failure — no body or non-JSON; fall through to SSE stream
      rawBody = null;
    }

    const parsed =
      rawBody != null
        ? RunAgentInputSchema.safeParse(rawBody)
        : { success: false as const };

    // 6. If body parsed successfully, call the adapter for new appends.
    // Active history resumes use AG-UI POST only to open the SSE stream; they
    // must not replay the last user message back into the follow-up queue.
    if (parsed.success) {
      const traceId =
        getTraceIdFromAgUiForwardedProps(parsed.data.forwardedProps) ??
        parsed.data.runId;
      recordAgentTraceSpan({
        traceId,
        name: "server.agui.post.received",
        attributes: {
          threadId,
          threadChatId,
          runId: parsed.data.runId,
        },
      });
      const intent = readTerragonPostIntent(parsed.data.forwardedProps);
      if (intent === "append") {
        const followUpStartedAtMs = Date.now();
        const result = await runFollowUpFromAgUiInput({
          threadId,
          threadChatId,
          userId,
          body: parsed.data,
          isReplayMode: false,
        });
        const resultKind =
          "error" in result
            ? result.error.kind
            : "runId" in result
              ? "dispatched"
              : result.skipped;
        recordAgentTraceSpan({
          traceId,
          name: "server.agui.followup.dispatched",
          startedAtMs: followUpStartedAtMs,
          endedAtMs: Date.now(),
          attributes: {
            threadId,
            threadChatId,
            runId: "runId" in result ? result.runId : parsed.data.runId,
            result: resultKind,
          },
        });

        if ("error" in result) {
          const { error } = result;
          if (error.kind === "unauthorized") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
          if (error.kind === "thread-not-found") {
            return NextResponse.json(
              { error: "Thread not found" },
              { status: 404 },
            );
          }
          if (error.kind === "lock-held") {
            return NextResponse.json(
              { error: "Run already in progress" },
              { status: 409 },
            );
          }
          if (error.kind === "invalid-input") {
            return NextResponse.json({ error: error.reason }, { status: 400 });
          }
        }
        // { runId } or { skipped } — fall through to SSE stream
      }
    }
    // Body absent or parse failed — fall through to SSE stream (back-compat)
  }

  // 7. Fall through: open the SSE stream via the existing GET handler
  return GET(request, ctx);
}
