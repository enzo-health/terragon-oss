/**
 * E2E integration test - ACP standard turn.
 *
 * Two-layer assertion strategy:
 *
 * Layer 1 - Route contract: Replays acp-standard-turn.jsonl through the real
 * daemon-event POST handler (in-process). Asserts every event returns HTTP 200,
 * verifying the route accepts ACP transport payloads with v2 envelopes and
 * test-auth bypass.
 *
 * Layer 2 - Projection/render contract: Synthesizes the persisted DB parts that
 * ACP emits (plan, terminal, diff, completed tool-call snapshot) and asserts
 * the key UI primitives render or persist with the expected shape.
 */
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replay } from "./replayer";
import { queryTerminalOutput, renderTerminalPart } from "./chat-page";
import { toDBMessage } from "../../src/agent/msg/toDBMessage";
import { PlanPartView } from "../../src/components/chat/plan-part";
import { DiffPartView } from "../../src/components/chat/diff-part";
import type {
  ClaudeMessage,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import type {
  DBAgentMessagePart,
  DBDiffPart,
  DBMessage,
  DBPlanPart,
  DBTerminalPart,
  DBToolCall,
} from "@terragon/shared";

const dbMocks = vi.hoisted(() => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const insertOnConflictDoNothing = vi.fn(() => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn(() => ({
    onConflictDoNothing: insertOnConflictDoNothing,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const deleteReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const updateReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({ execute, select, insert, delete: deleteFrom, update }),
  );
  return {
    execute,
    selectWhere,
    transaction,
    db: {
      execute,
      transaction,
      select,
      delete: deleteFrom,
      update,
      insert,
      query: {
        sdlcLoopSignalInbox: { findFirst: vi.fn().mockResolvedValue(null) },
      },
    },
  };
});

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn().mockResolvedValue(null),
  userOnlyAction: vi.fn((fn: unknown) => fn),
}));

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/db", () => ({ db: dbMocks.db }));

vi.mock("@terragon/shared/delivery-loop/store/dispatch-intent-store", () => ({
  createDispatchIntent: vi.fn().mockResolvedValue("di-1"),
  markDispatchIntentDispatched: vi.fn().mockResolvedValue(undefined),
  markDispatchIntentCompleted: vi.fn().mockResolvedValue(undefined),
  markDispatchIntentFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn().mockResolvedValue({
    processed: false,
    dispatchLaunched: false,
    reason: "no_queued_messages",
  }),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/dispatch-intent", () => ({
  buildDispatchIntentId: vi.fn(
    (loopId: string, runId: string) => `di_${loopId}_${runId}`,
  ),
  createDispatchIntent: vi
    .fn()
    .mockResolvedValue({ id: "di-1", status: "prepared" }),
  storeSelfDispatchReplay: vi.fn().mockResolvedValue(undefined),
  getReplayableSelfDispatch: vi.fn().mockResolvedValue(null),
  updateDispatchIntent: vi.fn().mockResolvedValue(undefined),
  getActiveDispatchIntent: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn().mockResolvedValue({
    runId: "run-acp-canonical-001",
    userId: "test-user-replay",
    threadId: "019cb55a-6ab5-7ad2-876b-dd1d3dedcf52",
    threadChatId: "chat-acp-canonical-001",
    sandboxId: "sandbox-acp-001",
    transportMode: "acp",
    protocolVersion: 2,
    agent: "claude-code",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status: "dispatched",
    tokenNonce: "nonce-acp",
    daemonTokenKeyId: "key-acp",
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  updateAgentRunContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn().mockResolvedValue(null),
  getThreadMinimal: vi.fn().mockResolvedValue(null),
  updateThreadChat: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  getActiveWorkflowForThread: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/v3/kernel", () => ({
  appendEventAndAdvance: vi.fn().mockResolvedValue(undefined),
  appendEventAndAdvanceExplicit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  getWorkflowHead: vi.fn().mockResolvedValue(null),
  getActiveWorkflowForThread: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => ({
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  },
  isLocalRedisHttpMode: vi.fn().mockReturnValue(false),
  isRedisTransportParseError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/server-lib/delivery-loop/ack-lifecycle", () => ({
  handleAckReceived: vi.fn().mockResolvedValue(undefined),
}));

const ACP_RECORDING = path.resolve(
  import.meta.dirname,
  "recordings/acp-standard-turn.jsonl",
);

const ACP_UI_MESSAGES: ClaudeMessage[] = [
  {
    type: "acp-plan",
    session_id: "sess-acp-001",
    entries: [
      {
        priority: "high",
        status: "pending",
        content: "Analyze current authentication middleware implementation",
      },
      {
        priority: "high",
        status: "pending",
        content: "Refactor JWT strategy to use modern best practices",
      },
      {
        priority: "medium",
        status: "pending",
        content: "Update error handling and logging in auth middleware",
      },
      {
        priority: "low",
        status: "pending",
        content: "Add comprehensive unit tests for authentication flows",
      },
    ],
  },
  {
    type: "acp-tool-call",
    session_id: "sess-acp-001",
    toolCallId: "tc_8b7c6d5e-4f3a-2b1c-9d8e-7f6a5b4c3d2e",
    title: "Read authentication middleware file",
    kind: "read",
    status: "completed",
    locations: [{ type: "file", path: "src/middleware/auth.ts", range: null }],
    rawInput:
      "Read the authentication middleware file to understand the current implementation",
    rawOutput: "File contents read successfully",
    startedAt: "2026-04-20T00:00:00.000Z",
    completedAt: "2026-04-20T00:00:01.000Z",
    progressChunks: [
      {
        seq: 0,
        text: "Reading file /src/middleware/auth.ts...\nFound 47 lines of authentication middleware code.\nCurrent implementation uses passport.js with JWT strategy.",
      },
      {
        seq: 1,
        text: "Successfully read /src/middleware/auth.ts. The file contains 47 lines using passport.js with JWT strategy and basic error handling.",
      },
    ],
  },
  {
    type: "acp-terminal",
    session_id: "sess-acp-001",
    terminalId: "term_abc123def456",
    chunks: [
      { streamSeq: 1, kind: "stdout", text: "$ npm run build\n" },
      { streamSeq: 2, kind: "stdout", text: "Running build script...\n" },
      {
        streamSeq: 3,
        kind: "stdout",
        text: "Build completed successfully\n",
      },
    ],
  },
  {
    type: "acp-diff",
    session_id: "sess-acp-001",
    filePath: "src/middleware/auth.ts",
    oldContent:
      "const authenticateUser = (req, res, next) => {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) {\n    res.status(401).send('Unauthorized');\n  }\n};\n",
    newContent:
      "const authenticateUser = (req, res, next) => {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) {\n    return res.status(401).json({ error: 'Unauthorized' });\n  }\n  try {\n    const decoded = jwt.verify(token, process.env.JWT_SECRET);\n    req.user = decoded;\n    next();\n  } catch (err) {\n    return res.status(401).json({ error: 'Invalid token' });\n  }\n};\n",
    unifiedDiff:
      "--- a/src/middleware/auth.ts\n+++ b/src/middleware/auth.ts\n@@ -1,7 +1,15 @@\n const authenticateUser = (req, res, next) => {\n   const token = req.headers.authorization?.split(' ')[1];\n   if (!token) {\n-    res.status(401).send('Unauthorized');\n+    return res.status(401).json({ error: 'Unauthorized' });\n+  }\n+  try {\n+    const decoded = jwt.verify(token, process.env.JWT_SECRET);\n+    req.user = decoded;\n+    next();\n+  } catch (err) {\n+    return res.status(401).json({ error: 'Invalid token' });\n   }\n };\n",
    status: "pending",
  },
];

function getAgentPart<TType extends DBAgentMessagePart["type"]>({
  messages,
  type,
}: {
  messages: DBMessage[];
  type: TType;
}): Extract<DBAgentMessagePart, { type: TType }> {
  for (const message of messages) {
    if (message.type !== "agent") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === type) {
        return part as Extract<DBAgentMessagePart, { type: TType }>;
      }
    }
  }
  throw new Error(`Missing agent part of type ${type}`);
}

function getToolCall(messages: DBMessage[]): DBToolCall {
  const toolCall = messages.find(
    (message): message is DBToolCall => message.type === "tool-call",
  );
  if (!toolCall) {
    throw new Error("Missing ACP tool-call DB message");
  }
  return toolCall;
}

describe("ACP standard turn - route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays all 7 events and gets HTTP 200 for each", async () => {
    const results = await replay(ACP_RECORDING, { mode: "fast-forward" });
    expect(results).toHaveLength(7);
    for (const result of results) {
      expect(result.status).toBe(200);
    }
  });

  it("events are processed in wallClockMs order (0 -> 600)", async () => {
    const results = await replay(ACP_RECORDING);
    const timestamps = results.map((result) => result.wallClockMs);
    expect(timestamps).toEqual([0, 80, 160, 240, 360, 480, 600]);
  });

  it("all events share the ACP transport and v2 run envelope", async () => {
    const results = await replay(ACP_RECORDING);
    for (const result of results) {
      const body = result.body as DaemonEventAPIBody;
      expect(body.threadId).toBe("019cb55a-6ab5-7ad2-876b-dd1d3dedcf52");
      expect(body.threadChatId).toBe("chat-acp-canonical-001");
      expect(body.transportMode).toBe("acp");
      expect(body.protocolVersion).toBe(2);
      expect(body.payloadVersion).toBe(2);
      expect(body.runId).toBe("run-acp-canonical-001");
      expect(body.acpServerId).toBe("terragon-run-acp-canonical-001");
    }
  });

  it("recording contains the expected ACP event sequence", async () => {
    const results = await replay(ACP_RECORDING);
    const messageTypes = results.map(
      (result) => (result.body.messages[0] as ClaudeMessage).type,
    );
    expect(messageTypes).toEqual([
      "acp-plan",
      "acp-tool-call",
      "acp-tool-call",
      "acp-tool-call",
      "acp-terminal",
      "acp-diff",
      "result",
    ]);
  });
});

describe("ACP standard turn - projection and rendering (Layer 2)", () => {
  it("persists the completed ACP tool-call snapshot with progress chunks", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const toolCall = getToolCall(dbMessages);

    expect(toolCall.name).toBe("Read authentication middleware file");
    expect(toolCall.status).toBe("completed");
    expect(toolCall.progressChunks).toHaveLength(2);
    expect(toolCall.parameters.kind).toBe("read");
    expect(toolCall.parameters.rawOutput).toBe(
      "File contents read successfully",
    );
  });

  it("renders the ACP plan entries as a structured plan card", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const planPart = getAgentPart({ messages: dbMessages, type: "plan" });
    const html = renderToStaticMarkup(
      <PlanPartView part={planPart as DBPlanPart} />,
    );

    expect(html).toContain(
      "Analyze current authentication middleware implementation",
    );
    expect(html).toContain(
      "Refactor JWT strategy to use modern best practices",
    );
    expect(html).toContain('data-priority="high"');
    expect(html).toContain('data-status="pending"');
  });

  it("renders the ACP terminal output with ordered stdout chunks", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const terminalPart = getAgentPart({
      messages: dbMessages,
      type: "terminal",
    });
    const html = renderTerminalPart(terminalPart as DBTerminalPart);
    const terminal = queryTerminalOutput(html);

    expect(terminal.found).toBe(true);
    expect(terminal.text).toContain("$ npm run build");
    expect(terminal.text).toContain("Build completed successfully");
    expect(Array.from(terminal.kinds)).toEqual(["stdout"]);
  });

  it("renders the ACP diff artifact header with pending state", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const diffPart = getAgentPart({ messages: dbMessages, type: "diff" });
    const html = renderToStaticMarkup(
      <DiffPartView part={diffPart as DBDiffPart} />,
    );

    expect(html).toContain("src/middleware/auth.ts");
    expect(html).toContain('data-status="pending"');
  });
});
