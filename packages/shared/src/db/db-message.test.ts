/**
 * Compile-time + runtime shape tests for db-message types introduced in
 * Sprint 1 of the chat-ui-protocol-gaps plan.
 *
 * These tests do NOT require a live database — they only assert that the
 * TypeScript compiler accepts the new shapes as valid DBMessage variants
 * and that runtime construction produces the expected objects.
 */

import { describe, expect, it } from "vitest";
import type {
  DBMessage,
  DBToolCall,
  DBAudioPart,
  DBResourceLinkPart,
  DBTerminalPart,
  DBDiffPart,
  DBDelegationMessage,
} from "./db-message";
import { DB_MESSAGE_SCHEMA_VERSION } from "./db-message";

// ---------------------------------------------------------------------------
// Task 1.1 — DBDelegationMessage
//
// Fixture reference:
//   packages/daemon/src/__fixtures__/codex/collab-agent-tool-call-completed.json
//   params.item fields: id, senderThreadId, receiverThreadIds, prompt, model,
//   reasoningEffort, agentsStates, tool, status
// ---------------------------------------------------------------------------

describe("DBDelegationMessage", () => {
  it("is accepted as DBMessage (compile-time + runtime)", () => {
    // Representative object modelled directly from the collab-agent-tool-call-completed fixture
    const msg: DBMessage = {
      type: "delegation",
      model: null,
      delegationId: "item_collab_001",
      tool: "message",
      status: "completed",
      senderThreadId: "019cb55a-6ab5-7ad2-876b-dd1d3dedcf52",
      receiverThreadIds: [
        "019cb55b-7bc6-8be3-987c-ee2e4eefdg63",
        "019cb55c-8cd7-9cf4-a98d-ff3f5ffgeh74",
      ],
      prompt:
        "Please help me refactor the authentication module with improved type safety and error handling",
      delegatedModel: "claude-3-5-sonnet-20241022",
      reasoningEffort: "medium",
      agentsStates: {
        "019cb55b-7bc6-8be3-987c-ee2e4eefdg63": "completed",
        "019cb55c-8cd7-9cf4-a98d-ff3f5ffgeh74": "completed",
      },
    };

    expect(msg.type).toBe("delegation");
  });

  it("accepts all tool variants", () => {
    const spawn: DBDelegationMessage = {
      type: "delegation",
      model: null,
      delegationId: "id-spawn",
      tool: "spawn",
      status: "initiated",
      senderThreadId: "sender",
      receiverThreadIds: [],
      prompt: "spawn task",
      delegatedModel: "claude-3-5-sonnet-20241022",
      agentsStates: {},
    };
    const kill: DBDelegationMessage = {
      type: "delegation",
      model: null,
      delegationId: "id-kill",
      tool: "kill",
      status: "failed",
      senderThreadId: "sender",
      receiverThreadIds: ["r1"],
      prompt: "kill task",
      delegatedModel: "claude-3-5-sonnet-20241022",
      agentsStates: { r1: "failed" },
    };

    expect(spawn.tool).toBe("spawn");
    expect(kill.tool).toBe("kill");
  });

  it("accepts optional timestamp and reasoningEffort", () => {
    const msg: DBDelegationMessage = {
      type: "delegation",
      model: null,
      delegationId: "id-ts",
      tool: "message",
      status: "running",
      senderThreadId: "s",
      receiverThreadIds: ["r"],
      prompt: "p",
      delegatedModel: "claude-3-haiku-20240307",
      reasoningEffort: "high",
      agentsStates: { r: "running" },
      timestamp: "2026-04-14T00:00:00.000Z",
    };

    expect(msg.timestamp).toBeDefined();
    expect(msg.reasoningEffort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Task 1.2 — Rich-content part variants
// ---------------------------------------------------------------------------

describe("DBAudioPart", () => {
  it("is accepted with data field", () => {
    const part: DBAudioPart = {
      type: "audio",
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    };
    expect(part.type).toBe("audio");
  });

  it("is accepted with uri field", () => {
    const part: DBAudioPart = {
      type: "audio",
      mimeType: "audio/ogg",
      uri: "https://example.com/audio.ogg",
    };
    expect(part.uri).toBeDefined();
  });

  it("is accepted as an agent-message part (DBMessage)", () => {
    const audioPart: DBAudioPart = {
      type: "audio",
      mimeType: "audio/mp4",
      uri: "https://example.com/clip.mp4",
    };
    const msg: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [audioPart],
    };
    expect(msg.type).toBe("agent");
  });
});

describe("DBResourceLinkPart", () => {
  it("is accepted with required fields only", () => {
    const part: DBResourceLinkPart = {
      type: "resource-link",
      uri: "https://example.com/file.pdf",
      name: "design-doc.pdf",
    };
    expect(part.type).toBe("resource-link");
  });

  it("is accepted with all optional fields", () => {
    const part: DBResourceLinkPart = {
      type: "resource-link",
      uri: "https://example.com/file.pdf",
      name: "design-doc.pdf",
      title: "Design Document",
      description: "Architecture overview",
      mimeType: "application/pdf",
      size: 204800,
    };
    expect(part.size).toBe(204800);
  });

  it("is accepted as an agent-message part (DBMessage)", () => {
    const part: DBResourceLinkPart = {
      type: "resource-link",
      uri: "s3://bucket/key",
      name: "key",
    };
    const msg: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [part],
    };
    expect(msg.type).toBe("agent");
  });
});

describe("DBTerminalPart", () => {
  it("is accepted with empty chunks", () => {
    const part: DBTerminalPart = {
      type: "terminal",
      sandboxId: "sbx-123",
      terminalId: "term-0",
      chunks: [],
    };
    expect(part.type).toBe("terminal");
  });

  it("is accepted with mixed chunk kinds", () => {
    const part: DBTerminalPart = {
      type: "terminal",
      sandboxId: "sbx-abc",
      terminalId: "term-1",
      chunks: [
        { streamSeq: 0, kind: "stdout", text: "Hello\n" },
        { streamSeq: 1, kind: "stderr", text: "Warning\n" },
        { streamSeq: 2, kind: "interaction", text: "> " },
      ],
    };
    expect(part.chunks).toHaveLength(3);
    expect(part.chunks[0]!.kind).toBe("stdout");
  });

  it("is accepted as an agent-message part (DBMessage)", () => {
    const part: DBTerminalPart = {
      type: "terminal",
      sandboxId: "s",
      terminalId: "t",
      chunks: [],
    };
    const msg: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "Output:" }, part],
    };
    expect(msg.type).toBe("agent");
  });
});

describe("DBDiffPart", () => {
  it("is accepted with required fields", () => {
    const part: DBDiffPart = {
      type: "diff",
      filePath: "src/index.ts",
      newContent: "export const x = 1;\n",
      status: "pending",
    };
    expect(part.type).toBe("diff");
  });

  it("is accepted with all optional fields", () => {
    const part: DBDiffPart = {
      type: "diff",
      filePath: "src/index.ts",
      oldContent: "export const x = 0;\n",
      newContent: "export const x = 1;\n",
      unifiedDiff: "@@ -1 +1 @@\n-export const x = 0;\n+export const x = 1;\n",
      status: "applied",
    };
    expect(part.status).toBe("applied");
    expect(part.unifiedDiff).toBeDefined();
  });

  it("is accepted as an agent-message part (DBMessage)", () => {
    const part: DBDiffPart = {
      type: "diff",
      filePath: "a.ts",
      newContent: "const a = 1;",
      status: "rejected",
    };
    const msg: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [part],
    };
    expect(msg.type).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// Task 1.3 — DBToolCall lifecycle fields
// ---------------------------------------------------------------------------

describe("DBToolCall lifecycle fields", () => {
  it("is valid without any lifecycle fields (legacy shape)", () => {
    const call: DBToolCall = {
      type: "tool-call",
      id: "tc-old",
      name: "bash",
      parameters: { command: "ls" },
      parent_tool_use_id: null,
    };
    expect(call.startedAt).toBeUndefined();
    expect(call.status).toBeUndefined();
    expect(call.progressChunks).toBeUndefined();
  });

  it("is valid with all lifecycle fields populated", () => {
    const call: DBToolCall = {
      type: "tool-call",
      id: "tc-new",
      name: "bash",
      parameters: { command: "npm test" },
      parent_tool_use_id: null,
      startedAt: "2026-04-14T00:00:00.000Z",
      completedAt: "2026-04-14T00:00:05.000Z",
      status: "completed",
      progressChunks: [
        { seq: 0, text: "Running tests..." },
        { seq: 1, text: "All tests passed." },
      ],
    };
    expect(call.status).toBe("completed");
    expect(call.progressChunks).toHaveLength(2);
  });

  it("is accepted as DBMessage", () => {
    const call: DBMessage = {
      type: "tool-call",
      id: "tc-msg",
      name: "read_file",
      parameters: { path: "/etc/hosts" },
      parent_tool_use_id: null,
      status: "in_progress",
      progressChunks: [{ seq: 0, text: "Reading..." }],
    };
    expect(call.type).toBe("tool-call");
  });

  it("accepts all status variants", () => {
    const statuses = ["started", "in_progress", "completed", "failed"] as const;
    for (const status of statuses) {
      const call: DBToolCall = {
        type: "tool-call",
        id: `tc-${status}`,
        name: "tool",
        parameters: {},
        parent_tool_use_id: null,
        status,
      };
      expect(call.status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 1.4 — DB_MESSAGE_SCHEMA_VERSION constant
// ---------------------------------------------------------------------------

describe("DB_MESSAGE_SCHEMA_VERSION", () => {
  it("is a positive integer", () => {
    expect(typeof DB_MESSAGE_SCHEMA_VERSION).toBe("number");
    expect(Number.isInteger(DB_MESSAGE_SCHEMA_VERSION)).toBe(true);
    expect(DB_MESSAGE_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("is currently 1 (bump when union changes incompatibly)", () => {
    expect(DB_MESSAGE_SCHEMA_VERSION).toBe(1);
  });
});
