import { EventType } from "@ag-ui/core";
import * as schema from "@terragon/shared/db/schema";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { upsertAgentRunContext } from "@terragon/shared/model/agent-run-context";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { nanoid } from "nanoid/non-secure";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
import { rejectTaskLivenessTestRequest } from "../task-liveness-guard";

type ReplayRecordingEvent = {
  wallClockMs: number;
  headers: Record<string, string>;
  body: {
    threadId: string;
    threadChatId: string;
    messages: Array<Record<string, unknown>>;
    timezone: string;
    payloadVersion: 2;
    eventId: string;
    runId: string;
    seq: number;
  };
};

type TaskLivenessScenarioResponse = {
  scenario: "task-liveness-terminal-vs-stale-workflow";
  userId: string;
  sessionToken: string;
  threadId: string;
  threadChatId: string;
  threadName: string;
  runId: string;
  replayRecording: ReplayRecordingEvent[];
};

export async function POST(request: NextRequest) {
  const rejected = rejectTaskLivenessTestRequest(request);
  if (rejected) {
    return rejected;
  }

  const now = new Date();
  const staleWorkflowUpdatedAt = new Date(now.getTime() - 10 * 60 * 1000);
  const runId = `run-task-liveness-${nanoid(10)}`;
  const threadName = `Task 6 Terminal vs Stale Workflow (${runId.slice(-6)})`;

  const { user, session } = await createTestUser({
    db,
    name: "Task Liveness E2E",
  });

  await db
    .update(schema.user)
    .set({ role: "admin" })
    .where(eq(schema.user.id, user.id));

  const { threadId, threadChatId } = await createTestThread({
    db,
    userId: user.id,
    overrides: {
      githubRepoFullName: "terragon/task-liveness-e2e",
      name: threadName,
      repoBaseBranchName: "main",
      sourceMetadata: {
        type: "www",
        deliveryLoopOptIn: true,
      },
    },
  });

  await db
    .update(schema.thread)
    .set({
      status: "complete",
      updatedAt: now,
    })
    .where(eq(schema.thread.id, threadId));

  await db
    .update(schema.threadChat)
    .set({
      status: "complete",
      messageSeq: 2,
      updatedAt: now,
    })
    .where(eq(schema.threadChat.id, threadChatId));

  const workflow = await createWorkflow({
    db,
    threadId,
    generation: 1,
    kind: "implementing",
    stateJson: {},
    userId: user.id,
    repoFullName: "terragon/task-liveness-e2e",
  });
  await ensureWorkflowHead({ db, workflowId: workflow.id });
  await db
    .update(schema.deliveryWorkflowHeadV3)
    .set({
      state: "implementing",
      activeRunId: runId,
      activeRunSeq: 2,
      updatedAt: staleWorkflowUpdatedAt,
      lastActivityAt: staleWorkflowUpdatedAt,
    })
    .where(eq(schema.deliveryWorkflowHeadV3.workflowId, workflow.id));

  await upsertAgentRunContext({
    db,
    runId,
    workflowId: workflow.id,
    runSeq: 2,
    userId: user.id,
    threadId,
    threadChatId,
    sandboxId: `sb-task-liveness-${nanoid(8)}`,
    transportMode: "legacy",
    protocolVersion: 2,
    agent: "codex",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: "sess-task-liveness",
    status: "completed",
    tokenNonce: `nonce-${nanoid(8)}`,
    daemonTokenKeyId: null,
  });

  await db.insert(schema.agentEventLog).values([
    {
      eventId: `${runId}:started`,
      runId,
      threadId,
      threadChatId,
      seq: 1,
      eventType: EventType.RUN_STARTED,
      category: EventType.RUN_STARTED,
      payloadJson: {
        type: EventType.RUN_STARTED,
        runId,
      },
      idempotencyKey: `${runId}:${EventType.RUN_STARTED}:1`,
      timestamp: new Date(now.getTime() - 2 * 60 * 1000),
      threadChatMessageSeq: 1,
    },
    {
      eventId: `${runId}:finished`,
      runId,
      threadId,
      threadChatId,
      seq: 2,
      eventType: EventType.RUN_FINISHED,
      category: EventType.RUN_FINISHED,
      payloadJson: {
        type: EventType.RUN_FINISHED,
        runId,
      },
      idempotencyKey: `${runId}:${EventType.RUN_FINISHED}:2`,
      timestamp: new Date(now.getTime() - 60_000),
      threadChatMessageSeq: 2,
    },
  ]);

  const replayRecording: ReplayRecordingEvent[] = [
    {
      wallClockMs: 0,
      headers: {
        "content-type": "application/json",
      },
      body: {
        threadId,
        threadChatId,
        messages: [
          {
            type: "assistant",
            session_id: "sess-task-liveness",
            parent_tool_use_id: null,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Task 6 seeded scenario started" },
              ],
            },
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: `${runId}:fixture:1`,
        runId,
        seq: 0,
      },
    },
    {
      wallClockMs: 120,
      headers: {
        "content-type": "application/json",
      },
      body: {
        threadId,
        threadChatId,
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 120,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: "Task 6 seeded scenario terminal event",
            session_id: "sess-task-liveness",
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: `${runId}:fixture:2`,
        runId,
        seq: 1,
      },
    },
  ];

  const payload: TaskLivenessScenarioResponse = {
    scenario: "task-liveness-terminal-vs-stale-workflow",
    userId: user.id,
    sessionToken: session.token,
    threadId,
    threadChatId,
    threadName,
    runId,
    replayRecording,
  };

  return NextResponse.json(payload, { status: 201 });
}
