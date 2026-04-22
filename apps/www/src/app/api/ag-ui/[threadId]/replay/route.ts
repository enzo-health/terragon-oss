import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import * as schema from "@terragon/shared/db/schema";
import {
  getAgUiEventsForRun,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AgUiReplayResponse = {
  events: BaseEvent[];
  runId: string | null;
  isComplete: boolean;
};

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

  let resolvedRunId: string | null = runIdParam;
  if (resolvedRunId === null) {
    try {
      resolvedRunId = await getLatestRunIdForThreadChat({
        db,
        threadChatId,
      });
    } catch (error) {
      console.error(
        "[ag-ui/replay] getLatestRunIdForThreadChat failed",
        { threadId, threadChatId },
        error,
      );
      resolvedRunId = null;
    }
  }

  if (resolvedRunId === null) {
    const response: AgUiReplayResponse = {
      events: [],
      runId: null,
      isComplete: false,
    };
    return NextResponse.json(response);
  }

  let runEvents: BaseEvent[];
  try {
    runEvents = await getAgUiEventsForRun({
      db,
      runId: resolvedRunId,
    });
  } catch (error) {
    console.error(
      "[ag-ui/replay] runId replay failed",
      { threadId, threadChatId, runId: resolvedRunId },
      error,
    );
    const errorEvent = mapRunErrorToAgui(
      error instanceof Error ? error.message : "Replay failed",
      "replay_failed",
    );
    const response: AgUiReplayResponse = {
      events: [errorEvent],
      runId: resolvedRunId,
      isComplete: true,
    };
    return NextResponse.json(response);
  }

  if (runEvents.length === 0) {
    const errorEvent = mapRunErrorToAgui(
      `Run ${resolvedRunId} has no events for thread chat ${threadChatId}`,
      "run_not_found",
    );
    const response: AgUiReplayResponse = {
      events: [errorEvent],
      runId: resolvedRunId,
      isComplete: true,
    };
    return NextResponse.json(response);
  }

  if (runEvents[0]?.type !== EventType.RUN_STARTED) {
    console.error("[ag-ui/replay] first event was not RUN_STARTED", {
      threadId,
      threadChatId,
      runId: resolvedRunId,
      firstType: runEvents[0]?.type,
    });
    const errorEvent = mapRunErrorToAgui(
      `Run ${resolvedRunId} log is malformed: first event is ${runEvents[0]?.type ?? "empty"}, expected RUN_STARTED`,
      "replay_failed",
    );
    const response: AgUiReplayResponse = {
      events: [errorEvent],
      runId: resolvedRunId,
      isComplete: true,
    };
    return NextResponse.json(response);
  }

  const isComplete = runEvents.some(
    (event) =>
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR,
  );

  const response: AgUiReplayResponse = {
    events: runEvents,
    runId: resolvedRunId,
    isComplete,
  };
  return NextResponse.json(response);
}
