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

import { EventType } from "@ag-ui/core";
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
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toDBMessage } from "../../src/agent/msg/toDBMessage";
import { queryTerminalChunks } from "./chat-page";
import { replay } from "./replayer";

const dbMocks = vi.hoisted(() => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const insertOnConflictDoNothing = vi.fn(() => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn((_values: unknown) => ({
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
    insertValues,
    transaction,
    db: {
      execute,
      transaction,
      select,
      delete: deleteFrom,
      update,
      insert,
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

vi.mock("@/server-lib/daemon-event-db-preflight", () => ({
  getDaemonEventDbPreflight: vi.fn().mockResolvedValue({
    agentEventLogReady: true,
    agentRunContextFailureColumnsReady: true,
    missing: [],
  }),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  completeAgentRunContextTerminal: vi
    .fn()
    .mockImplementation(async (params) => ({
      status: "committed",
      runContext: {
        runId: params.runId,
        userId: params.userId,
        threadId: params.threadId,
        threadChatId: params.threadChatId,
        status: params.terminalStatus,
      },
    })),
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
  updateThreadChatTerminalMetadataIfTerminal: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn().mockResolvedValue({
    updatedStatus: null,
    didUpdateStatus: false,
  }),
}));

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    xadd: vi.fn().mockResolvedValue("1-0"),
    pipeline: vi.fn(() => ({
      set: vi.fn(),
      del: vi.fn(),
      srem: vi.fn(),
      scard: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  },
  isLocalRedisHttpMode: vi.fn().mockReturnValue(false),
  isRedisTransportParseError: vi.fn().mockReturnValue(false),
}));

const ACP_RECORDING = path.resolve(
  import.meta.dirname,
  "recordings/acp-standard-turn.jsonl",
);

const ACP_STREAMING_RECORDING = path.resolve(
  import.meta.dirname,
  "recordings/acp-streaming-turn.jsonl",
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

type InsertedAgUiRow = {
  eventId: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInsertedAgUiRow(value: unknown): value is InsertedAgUiRow {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.eventType === "string" &&
    isRecord(value.payloadJson)
  );
}

function getInsertedAgUiRows(): InsertedAgUiRow[] {
  return dbMocks.insertValues.mock.calls.flatMap(([value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.filter(isInsertedAgUiRow);
  });
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

describe("ACP streaming turn - route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays delta-only ACP events and gets HTTP 200 for each", async () => {
    const results = await replay(ACP_STREAMING_RECORDING, {
      mode: "fast-forward",
    });

    expect(results).toHaveLength(5);
    expect(results.map((result) => result.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(results.map((result) => result.body.seq)).toEqual([0, 1, 2, 3, 4]);

    const deltaBodies = results
      .map((result) => result.body)
      .filter((body) => (body.deltas?.length ?? 0) > 0);
    expect(deltaBodies).toHaveLength(3);
    expect(deltaBodies.every((body) => body.messages.length === 0)).toBe(true);
    expect(deltaBodies.map((body) => body.transportMode)).toEqual([
      "acp",
      "acp",
      "acp",
    ]);
  });

  it("persists streaming ACP deltas as AG-UI rows", async () => {
    await replay(ACP_STREAMING_RECORDING, { mode: "fast-forward" });

    const rows = getInsertedAgUiRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ]);
    expect(rows.map((row) => row.eventId)).toEqual([
      "canon-acp-stream-start:RUN_STARTED:0",
      "delta-start:run-acp-canonical-001:msg-acp-stream-1:text",
      "delta:run-acp-canonical-001:msg-acp-stream-1:0:text:0",
      "delta-start:run-acp-canonical-001:msg-acp-stream-1:text",
      "delta:run-acp-canonical-001:msg-acp-stream-1:0:text:1",
      "delta:run-acp-canonical-001:tool-acp-stream-1:0:tool-output:0",
      "canon-acp-stream-finished:RUN_FINISHED:0",
    ]);

    const textContentRows = rows.filter(
      (row) => row.eventType === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(textContentRows.map((row) => row.payloadJson)).toEqual([
      expect.objectContaining({
        messageId: "msg-acp-stream-1",
        delta: "I'll inspect ",
      }),
      expect.objectContaining({
        messageId: "msg-acp-stream-1",
        delta: "the auth middleware.",
      }),
    ]);
    expect(
      rows.find((row) => row.eventType === EventType.TOOL_CALL_RESULT)
        ?.payloadJson,
    ).toEqual(
      expect.objectContaining({
        messageId: "tool-acp-stream-1",
        toolCallId: "tool-acp-stream-1",
        content: "npm test\nPASS\n",
      }),
    );
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

  it("projects the ACP plan entries with priority and status", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const planPart = getAgentPart({
      messages: dbMessages,
      type: "plan",
    }) as DBPlanPart;

    const contents = planPart.entries.map((entry) => entry.content);
    expect(contents).toContain(
      "Analyze current authentication middleware implementation",
    );
    expect(contents).toContain(
      "Refactor JWT strategy to use modern best practices",
    );
    expect(planPart.entries.some((entry) => entry.priority === "high")).toBe(
      true,
    );
    expect(planPart.entries.every((entry) => entry.status === "pending")).toBe(
      true,
    );
  });

  it("projects the ACP terminal output with ordered stdout chunks", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const terminalPart = getAgentPart({
      messages: dbMessages,
      type: "terminal",
    });
    const terminal = queryTerminalChunks(terminalPart as DBTerminalPart);

    expect(terminal.found).toBe(true);
    expect(terminal.text).toContain("$ npm run build");
    expect(terminal.text).toContain("Build completed successfully");
    expect(Array.from(terminal.kinds)).toEqual(["stdout"]);
  });

  it("projects the ACP diff artifact with file path and pending state", () => {
    const dbMessages = ACP_UI_MESSAGES.flatMap((message) =>
      toDBMessage(message),
    );
    const diffPart = getAgentPart({
      messages: dbMessages,
      type: "diff",
    }) as DBDiffPart;

    expect(diffPart.filePath).toBe("src/middleware/auth.ts");
    expect(diffPart.status).toBe("pending");
  });
});
