import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { getThreadChat } from "@terragon/shared/model/threads";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { stopThread as stopThreadInternal } from "@/server-lib/stop-thread";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { getNativeAgUiTranscriptForThreadChat } from "@/server-lib/ag-ui-side-effect-messages";
import {
  buildDeltaBatch,
  buildMessagesBatch,
  createEmulatorRunState,
  EMULATOR_SESSION_ID,
} from "./daemon-batches";
import { terminalMessages } from "./scenarios";
import { replay } from "../../../test/integration/replayer";

async function replayBatches(
  batches: DaemonEventAPIBody[],
  userId: string,
): Promise<void> {
  for (const body of batches) {
    const [result] = await replay([{ wallClockMs: 0, body, headers: {} }], {
      userId,
    });
    if (!result || result.status >= 400) {
      throw new Error(
        `emulator batch rejected (${result?.status}): ${JSON.stringify(
          result?.responseBody,
        )}`,
      );
    }
  }
}

describe("agent emulator integration", () => {
  it("drives a full emulated run through the real daemon-event route", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "emulator-sandbox",
        sandboxProvider: "mock",
        disableGitCheckpointing: true,
      },
      chatOverrides: { status: "booting" },
    });

    const runId = `run-emulator-${crypto.randomUUID()}`;
    await db.insert(schema.agentRunContext).values({
      runId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "emulator-sandbox",
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "processing",
      tokenNonce: `nonce-${runId}`,
    });

    const state = createEmulatorRunState({
      runId,
      threadId,
      threadChatId,
      timezone: "UTC",
    });

    const batches: DaemonEventAPIBody[] = [
      buildMessagesBatch(state, [
        {
          type: "system",
          subtype: "init",
          session_id: EMULATOR_SESSION_ID,
          tools: ["Bash"],
          mcp_servers: [],
        },
      ]),
      buildDeltaBatch(state, [
        {
          messageId: "emulated-text",
          partIndex: 0,
          kind: "text",
          text: "Emulated hello",
        },
      ]),
      buildMessagesBatch(state, [
        {
          type: "assistant",
          parent_tool_use_id: null,
          session_id: EMULATOR_SESSION_ID,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "emulated-bash",
                name: "Bash",
                input: { command: "echo hi" },
              },
            ],
          },
        },
      ]),
      buildDeltaBatch(state, [
        {
          messageId: "emulated-bash",
          partIndex: 0,
          kind: "tool-output",
          text: "hi\n",
          toolCallId: "emulated-bash",
          stream: "stdout",
        },
      ]),
      buildMessagesBatch(state, [
        {
          type: "user",
          parent_tool_use_id: null,
          session_id: EMULATOR_SESSION_ID,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "emulated-bash",
                content: "hi\n",
              },
            ],
          },
        },
      ]),
      buildMessagesBatch(
        state,
        terminalMessages({ kind: "completed", resultText: "done" }),
      ),
    ];

    await replayBatches(batches, user.id);

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("complete");
    expect(threadChat!.errorMessage).toBeNull();

    const runContext = await db.query.agentRunContext.findFirst({
      where: (row, { eq }) => eq(row.runId, runId),
    });
    expect(runContext!.status).toBe("completed");

    const transcript = await getNativeAgUiTranscriptForThreadChat({
      db,
      threadChatId,
    });
    expect(transcript.history).toContain("Emulated hello");

    const eventRows = await db.query.agentEventLog.findMany({
      where: (row, { eq }) => eq(row.runId, runId),
    });
    const serializedEvents = JSON.stringify(
      eventRows.map((row) => row.payloadJson),
    );
    expect(serializedEvents).toContain("emulated-bash");
    expect(eventRows.some((row) => row.eventType === "TOOL_CALL_START")).toBe(
      true,
    );
  });

  it("ends a rate-limit scenario on a recoverable terminal that queues the chat", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { codesandboxId: "emulator-sandbox", sandboxProvider: "mock" },
      chatOverrides: { status: "working" },
    });

    const runId = `run-emulator-rl-${crypto.randomUUID()}`;
    await db.insert(schema.agentRunContext).values({
      runId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "emulator-sandbox",
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "processing",
      tokenNonce: `nonce-${runId}`,
    });

    const state = createEmulatorRunState({
      runId,
      threadId,
      threadChatId,
      timezone: "UTC",
    });
    const resetTimeSec = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const batches: DaemonEventAPIBody[] = [
      buildMessagesBatch(state, [
        {
          type: "system",
          subtype: "init",
          session_id: EMULATOR_SESSION_ID,
          tools: ["Bash"],
          mcp_servers: [],
        },
      ]),
      buildMessagesBatch(
        state,
        terminalMessages({ kind: "rate-limit", resetTimeSec }),
      ),
    ];

    await replayBatches(batches, user.id);

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("queued-agent-rate-limit");
  });

  it("reconciles a mid-stream user stop to a stopped terminal without re-completion", async () => {
    await mockWaitUntil();
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: null,
        sandboxProvider: "mock",
        disableGitCheckpointing: true,
      },
      chatOverrides: { status: "working" },
    });

    const runId = `run-emulator-stop-${crypto.randomUUID()}`;
    await db.insert(schema.agentRunContext).values({
      runId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: `emulator-${threadChatId}`,
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      runtimeProvider: "claude-acp",
      status: "processing",
      tokenNonce: `nonce-${runId}`,
    });

    const state = createEmulatorRunState({
      runId,
      threadId,
      threadChatId,
      timezone: "UTC",
    });

    await replayBatches(
      [
        buildMessagesBatch(state, [
          {
            type: "system",
            subtype: "init",
            session_id: EMULATOR_SESSION_ID,
            tools: ["Bash"],
            mcp_servers: [],
          },
        ]),
        buildDeltaBatch(state, [
          {
            messageId: "emulated-stop-text",
            partIndex: 0,
            kind: "text",
            text: "streaming when interrupted",
          },
        ]),
      ],
      user.id,
    );

    await stopThreadInternal({ userId: user.id, threadId, threadChatId });
    await waitUntilResolved();

    const stoppingChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(stoppingChat!.status).toBe("stopping");
    const stoppedRun = await getAgentRunContextByRunId({
      db,
      runId,
      userId: user.id,
    });
    expect(stoppedRun!.status).toBe("stopped");

    await replayBatches(
      [buildMessagesBatch(state, terminalMessages({ kind: "stopped" }))],
      user.id,
    );

    const finalChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(finalChat!.status).toBe("complete");
    const finalRun = await getAgentRunContextByRunId({
      db,
      runId,
      userId: user.id,
    });
    expect(finalRun!.status).toBe("stopped");
  });
});
