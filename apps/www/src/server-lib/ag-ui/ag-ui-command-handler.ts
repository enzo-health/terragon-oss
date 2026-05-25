import { RunAgentInputSchema } from "@ag-ui/core";
import type { NextRequest } from "next/server";
import { classifyAgUiPostIntent } from "@/lib/ag-ui-replay-cursor";
import {
  getTraceIdFromAgUiForwardedProps,
  recordAgentTraceSpan,
} from "@/lib/agent-trace";
import { dispatchFollowUpFromAppend } from "@/server-lib/follow-up-command";

export type AgUiPostCommandResult =
  | { type: "open-stream" }
  | {
      type: "response";
      status: 400 | 403 | 404 | 409;
      body: { error: string };
    };

export async function handleAgUiPostCommand(args: {
  request: NextRequest;
  threadId: string;
  threadChatId: string;
  userId: string;
  isReplayMode: boolean;
}): Promise<AgUiPostCommandResult> {
  const { request, threadId, threadChatId, userId, isReplayMode } = args;

  if (isReplayMode) {
    return { type: "open-stream" };
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { type: "open-stream" };
  }

  const parsed = RunAgentInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { type: "open-stream" };
  }

  const body = parsed.data;
  const traceId =
    getTraceIdFromAgUiForwardedProps(body.forwardedProps) ?? body.runId;
  recordAgentTraceSpan({
    traceId,
    name: "server.agui.post.received",
    attributes: {
      threadId,
      threadChatId,
      runId: body.runId,
    },
  });

  const intent = classifyAgUiPostIntent({
    lastEventId: request.headers.get("last-event-id"),
    fromSeq: request.nextUrl.searchParams.get("fromSeq"),
    body,
  });
  if (intent === "resume") {
    return { type: "open-stream" };
  }

  const followUpStartedAtMs = Date.now();
  const result = await dispatchFollowUpFromAppend({
    threadId,
    threadChatId,
    userId,
    body,
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
      runId: "runId" in result ? result.runId : body.runId,
      result: resultKind,
    },
  });

  if (!("error" in result)) {
    return { type: "open-stream" };
  }

  const { error } = result;
  if (error.kind === "unauthorized") {
    return { type: "response", status: 403, body: { error: "Forbidden" } };
  }
  if (error.kind === "thread-not-found") {
    return {
      type: "response",
      status: 404,
      body: { error: "Thread not found" },
    };
  }
  if (error.kind === "lock-held") {
    return {
      type: "response",
      status: 409,
      body: { error: "Run already in progress" },
    };
  }
  return { type: "response", status: 400, body: { error: error.reason } };
}
