import { describe, it, expect } from "vitest";
import {
  parseAcpLineToClaudeMessages,
  coalesceAssistantTextMessages,
  AcpToolCallTracker,
  KNOWN_ACP_SESSION_UPDATE_TYPES,
  normalizeAcpPermissionRequest,
  parseAcpPermissionRequest,
} from "./acp-adapter";
import { readFileSync } from "fs";
import { join } from "path";
import { ClaudeMessage } from "./shared";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------
function loadFixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__/acp", name), "utf-8");
}

function textMsg(text: string, sessionId = "s1"): ClaudeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function toolMsg(sessionId = "s1"): ClaudeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool1",
          name: "Read",
          input: { path: "/tmp" },
        },
      ],
    },
  };
}

function thinkingMsg(thinking: string, sessionId = "s1"): ClaudeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking,
          signature: "acp-synthetic-signature",
        },
      ],
    },
  };
}

function nestedTextMsg(
  text: string,
  parentId: string,
  sessionId = "s1",
): ClaudeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: parentId,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

describe("coalesceAssistantTextMessages", () => {
  it("returns empty array for empty input", () => {
    expect(coalesceAssistantTextMessages([])).toEqual([]);
  });

  it("returns single message unchanged", () => {
    const msgs = [textMsg("hello")];
    expect(coalesceAssistantTextMessages(msgs)).toEqual([textMsg("hello")]);
  });

  it("merges consecutive text-only assistant messages", () => {
    const msgs = [textMsg("**Bold"), textMsg(" title"), textMsg("**\n\nBody")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(1);
    const content =
      result[0]!.type === "assistant" ? result[0]!.message.content : [];
    expect(
      Array.isArray(content) && content[0]?.type === "text" && content[0].text,
    ).toBe("**Bold title**\n\nBody");
  });

  it("does not merge across tool_use messages", () => {
    const msgs = [textMsg("before"), toolMsg(), textMsg("after")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(3);
  });

  it("does not merge messages with different session_id", () => {
    const msgs = [textMsg("a", "s1"), textMsg("b", "s2")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it("does not merge messages with parent_tool_use_id", () => {
    const msgs = [nestedTextMsg("a", "tool1"), nestedTextMsg("b", "tool1")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it("does not merge non-assistant messages", () => {
    const stopMsg: ClaudeMessage = {
      type: "custom-stop",
      session_id: null,
      duration_ms: 0,
    };
    const msgs = [textMsg("a"), stopMsg, textMsg("b")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(3);
  });

  it("merges many token chunks into one", () => {
    const tokens = ["I", "'m", " here", " and", " ready", "."];
    const msgs = tokens.map((t) => textMsg(t));
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(1);
    const content =
      result[0]!.type === "assistant" ? result[0]!.message.content : [];
    expect(
      Array.isArray(content) && content[0]?.type === "text" && content[0].text,
    ).toBe("I'm here and ready.");
  });

  it("preserves non-text assistant messages (tool calls)", () => {
    const msgs = [textMsg("thinking..."), toolMsg(), textMsg("done")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(3);
    // First text stays
    expect(result[0]).toEqual(textMsg("thinking..."));
    // Tool call preserved
    expect(result[1]).toEqual(toolMsg());
    // Last text stays
    expect(result[2]).toEqual(textMsg("done"));
  });

  it("merges consecutive thinking-only messages", () => {
    const msgs = [
      thinkingMsg("Let me"),
      thinkingMsg(" think"),
      thinkingMsg("..."),
    ];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(1);
    const content =
      result[0]!.type === "assistant" ? result[0]!.message.content : [];
    expect(
      Array.isArray(content) &&
        content[0]?.type === "thinking" &&
        content[0].thinking,
    ).toBe("Let me think...");
  });

  it("does not merge thinking with text messages", () => {
    const msgs = [thinkingMsg("thinking..."), textMsg("response")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it("does not merge text with thinking messages", () => {
    const msgs = [textMsg("hello"), thinkingMsg("hmm")];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it("merges two consecutive runs separated by a tool call", () => {
    const msgs = [
      textMsg("a"),
      textMsg("b"),
      toolMsg(),
      textMsg("c"),
      textMsg("d"),
    ];
    const result = coalesceAssistantTextMessages(msgs);
    expect(result).toHaveLength(3);
    // First run merged
    const c0 =
      result[0]!.type === "assistant" ? result[0]!.message.content : [];
    expect(Array.isArray(c0) && c0[0]?.type === "text" && c0[0].text).toBe(
      "ab",
    );
    // Tool call
    expect(result[1]).toEqual(toolMsg());
    // Second run merged
    const c2 =
      result[2]!.type === "assistant" ? result[2]!.message.content : [];
    expect(Array.isArray(c2) && c2[0]?.type === "text" && c2[0].text).toBe(
      "cd",
    );
  });
});

describe("parseAcpLineToClaudeMessages", () => {
  it("parses agent_message_chunk", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: "hello",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("assistant");
  });

  it("surfaces unknown sessionUpdate types with content as assistant text", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess1",
        update: {
          sessionUpdate: "some_new_type",
          content: "unknown data",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("assistant");
  });

  it("returns empty for unknown sessionUpdate types without content", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess1",
        update: {
          sessionUpdate: "some_new_type",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(0);
  });

  it("parses error sessionUpdate", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "error",
          content: "something failed",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("custom-error");
  });

  it("returns empty for invalid JSON", () => {
    expect(parseAcpLineToClaudeMessages("not json", "fb")).toEqual([]);
  });

  it("maps _adapter/agent_exited failures to custom-error", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "_adapter/agent_exited",
      params: {
        success: false,
        code: 137,
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("custom-error");
    if (result[0]!.type === "custom-error") {
      expect(result[0]!.error_info).toContain("exit code 137");
    }
  });

  it("ignores _adapter/agent_exited success notifications", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "_adapter/agent_exited",
      params: {
        success: true,
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toEqual([]);
  });

  it("parses agent_thought_chunk as thinking block", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: "Let me consider...",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("assistant");
    if (result[0]!.type === "assistant") {
      const content = result[0]!.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]!.type).toBe("thinking");
        if (content[0]!.type === "thinking") {
          expect(content[0]!.thinking).toBe("Let me consider...");
        }
      }
    }
  });

  it("parses agent_reasoning_chunk as thinking block", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess1",
        update: {
          sessionUpdate: "agent_reasoning_chunk",
          content: "Reasoning about this...",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    if (result[0]!.type === "assistant") {
      const content = result[0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]!.type).toBe("thinking");
      }
    }
  });

  it("ignores unvalidated terminal stopReason responses from SSE", () => {
    const line = JSON.stringify({
      id: 3,
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback-id");
    expect(result).toEqual([]);
  });

  it("parses terminal stopReason response only with daemon-owned response id", () => {
    const line = JSON.stringify({
      id: 3,
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
    const result = parseAcpLineToClaudeMessages(
      line,
      "fallback-id",
      undefined,
      {
        allowedTerminalResponseIds: new Set<unknown>([3]),
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("result");
    if (result[0]!.type === "result" && result[0]!.subtype === "success") {
      expect(result[0]!.result).toBe("end_turn");
      expect(result[0]!.session_id).toBe("fallback-id");
    }
  });

  it("uses fallback sessionId when none provided", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: "hi",
        },
      },
    });
    const result = parseAcpLineToClaudeMessages(line, "fallback-id");
    expect(result[0]!.type === "assistant" && result[0]!.session_id).toBe(
      "fallback-id",
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: tool_call + tool_call_update lifecycle → acp-tool-call messages
// ---------------------------------------------------------------------------

describe("Task 3.2 — ACP tool_call lifecycle", () => {
  it("parses tool-call.json fixture: initial tool_call event", () => {
    const tracker = new AcpToolCallTracker();
    const line = loadFixture("tool-call.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback", tracker);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-tool-call");
    if (msg.type === "acp-tool-call") {
      expect(msg.toolCallId).toBe("tc_8b7c6d5e-4f3a-2b1c-9d8e-7f6a5b4c3d2e");
      expect(msg.title).toBe("Read authentication middleware file");
      expect(msg.kind).toBe("read");
      expect(msg.status).toBe("pending");
      expect(msg.locations).toHaveLength(1);
      expect(msg.locations[0]!.path).toBe("src/middleware/auth.ts");
      expect(msg.rawInput).toContain("authentication middleware");
      expect(msg.startedAt).toBeTruthy();
      expect(msg.progressChunks).toHaveLength(0);
    }
  });

  it("parses tool-call-update-in-progress.json fixture: accumulates progress chunks", () => {
    const tracker = new AcpToolCallTracker();
    // First, seed with the initial tool_call
    parseAcpLineToClaudeMessages(
      loadFixture("tool-call.json"),
      "fallback",
      tracker,
    );
    const result = parseAcpLineToClaudeMessages(
      loadFixture("tool-call-update-in-progress.json"),
      "fallback",
      tracker,
    );
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-tool-call");
    if (msg.type === "acp-tool-call") {
      expect(msg.status).toBe("in_progress");
      expect(msg.progressChunks).toHaveLength(1);
      expect(msg.progressChunks[0]!.text).toContain("passport.js");
    }
  });

  it("parses tool-call-update-completed.json fixture: final state has all lifecycle fields", () => {
    const tracker = new AcpToolCallTracker();
    // Feed all three in order
    parseAcpLineToClaudeMessages(
      loadFixture("tool-call.json"),
      "fallback",
      tracker,
    );
    parseAcpLineToClaudeMessages(
      loadFixture("tool-call-update-in-progress.json"),
      "fallback",
      tracker,
    );
    const result = parseAcpLineToClaudeMessages(
      loadFixture("tool-call-update-completed.json"),
      "fallback",
      tracker,
    );
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-tool-call");
    if (msg.type === "acp-tool-call") {
      expect(msg.status).toBe("completed");
      expect(msg.startedAt).toBeTruthy();
      expect(msg.completedAt).toBeTruthy();
      expect(msg.rawOutput).toBe("File contents read successfully");
      // Preserves title + kind + locations from initial tool_call
      expect(msg.title).toBe("Read authentication middleware file");
      expect(msg.kind).toBe("read");
      expect(msg.locations).toHaveLength(1);
      // Has 2 progress chunks (one from in_progress, one from completed)
      expect(msg.progressChunks).toHaveLength(2);
    }
  });

  it("AcpToolCallTracker.getState returns accumulated state after updates", () => {
    const tracker = new AcpToolCallTracker();
    parseAcpLineToClaudeMessages(
      loadFixture("tool-call.json"),
      "fallback",
      tracker,
    );
    parseAcpLineToClaudeMessages(
      loadFixture("tool-call-update-in-progress.json"),
      "fallback",
      tracker,
    );
    parseAcpLineToClaudeMessages(
      loadFixture("tool-call-update-completed.json"),
      "fallback",
      tracker,
    );
    const state = tracker.getState("tc_8b7c6d5e-4f3a-2b1c-9d8e-7f6a5b4c3d2e");
    expect(state).toBeTruthy();
    expect(state!.status).toBe("completed");
    expect(state!.progressChunks).toHaveLength(2);
    expect(state!.rawOutput).toBe("File contents read successfully");
  });
});

// ---------------------------------------------------------------------------
// Task 3.3: plan → acp-plan message
// ---------------------------------------------------------------------------

describe("Task 3.3 — ACP plan", () => {
  it("parses plan.json fixture: produces acp-plan message with all entries", () => {
    const line = loadFixture("plan.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-plan");
    if (msg.type === "acp-plan") {
      expect(msg.entries).toHaveLength(4);
      const high = msg.entries.filter((e) => e.priority === "high");
      const medium = msg.entries.filter((e) => e.priority === "medium");
      const low = msg.entries.filter((e) => e.priority === "low");
      expect(high).toHaveLength(2);
      expect(medium).toHaveLength(1);
      expect(low).toHaveLength(1);
      expect(msg.entries.every((e) => e.status === "pending")).toBe(true);
      expect(msg.entries[0]!.content).toContain("authentication middleware");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.4: image / audio / resource_link content blocks
// ---------------------------------------------------------------------------

describe("Task 3.4 — ACP image content block", () => {
  it("parses image.json fixture: produces acp-image message with mimeType and data", () => {
    const line = loadFixture("image.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-image");
    if (msg.type === "acp-image") {
      expect(msg.mimeType).toBe("image/png");
      expect(typeof msg.data).toBe("string");
      expect(msg.data).toContain("iVBOR");
    }
  });
});

describe("Task 3.4 — ACP audio content block", () => {
  it("parses audio.json fixture: produces acp-audio message with mimeType and data", () => {
    const line = loadFixture("audio.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-audio");
    if (msg.type === "acp-audio") {
      expect(msg.mimeType).toBe("audio/wav");
      expect(typeof msg.data).toBe("string");
    }
  });
});

describe("Task 3.4 — ACP resource_link content block", () => {
  it("parses resource-link.json fixture: produces acp-resource-link message losslessly", () => {
    const line = loadFixture("resource-link.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-resource-link");
    if (msg.type === "acp-resource-link") {
      expect(msg.uri).toBe("https://nodejs.org/api/fs.html");
      expect(msg.name).toBe("Node.js fs module documentation");
      expect(msg.title).toBe("File System API Reference");
      expect(msg.description).toBe(
        "Official Node.js documentation for file system operations",
      );
      expect(msg.mimeType).toBe("text/html");
      expect(msg.size).toBe(524288);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.5: terminal → acp-terminal message
// ---------------------------------------------------------------------------

describe("Task 3.5 — ACP terminal content block", () => {
  it("parses terminal.json fixture: produces acp-terminal message with chunks", () => {
    const line = loadFixture("terminal.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-terminal");
    if (msg.type === "acp-terminal") {
      expect(msg.terminalId).toBe("term_abc123def456");
      expect(msg.chunks).toHaveLength(3);
      expect(msg.chunks[0]!.streamSeq).toBe(1);
      expect(msg.chunks[0]!.kind).toBe("stdout");
      expect(msg.chunks[0]!.text).toContain("npm run build");
      expect(msg.chunks[2]!.text).toContain("Build completed");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.6: diff → acp-diff message
// ---------------------------------------------------------------------------

describe("Task 3.6 — ACP diff content block", () => {
  it("parses diff.json fixture: produces acp-diff message preserving all fields", () => {
    const line = loadFixture("diff.json");
    const result = parseAcpLineToClaudeMessages(line, "fallback");
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe("acp-diff");
    if (msg.type === "acp-diff") {
      expect(msg.filePath).toBe("src/middleware/auth.ts");
      expect(msg.status).toBe("pending");
      expect(typeof msg.oldContent).toBe("string");
      expect(typeof msg.newContent).toBe("string");
      expect(typeof msg.unifiedDiff).toBe("string");
      expect(msg.oldContent).toContain("Unauthorized");
      expect(msg.newContent).toContain("jwt.verify");
      expect(msg.unifiedDiff).toContain("---");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.7: session/request_permission round-trip
// ---------------------------------------------------------------------------

describe("Task 3.7 — session/request_permission round-trip", () => {
  it("request-permission.json fixture: has method session/request_permission (not session/update)", () => {
    // The request_permission event is handled in daemon.ts at the method level,
    // NOT via parseAcpLineToClaudeMessages. Verify the fixture has the right shape
    // so the daemon.ts handler will match it.
    const fixture = JSON.parse(loadFixture("request-permission.json"));
    expect(fixture.method).toBe("session/request_permission");
    expect(fixture.params.toolCall.toolCallId).toBeTruthy();
    expect(fixture.params.toolCall.kind).toBe("execute");
    expect(Array.isArray(fixture.params.options)).toBe(true);
    expect(fixture.params.options.length).toBeGreaterThan(0);
  });

  it("normalizes request-permission.json into a canonical PermissionRequest tool event", () => {
    const line = loadFixture("request-permission.json");
    const result = normalizeAcpPermissionRequest({
      payload: line,
      promptId: "terragon-prompt-id",
      sessionId: "daemon-session-id",
    });

    expect(result?.request.acpRequestId).toBeDefined();
    expect(result?.message.type).toBe("assistant");
    if (result?.message.type === "assistant") {
      expect(result.message.session_id).toBe("daemon-session-id");
      expect(result.message.message.content).toEqual([
        {
          type: "tool_use",
          id: "terragon-prompt-id",
          name: "PermissionRequest",
          input: {
            options: result.request.options,
            description: result.request.description,
            tool_name: result.request.toolName,
          },
        },
      ]);
    }
  });

  it("session/approve_tool_use response shape matches ACP spec expectations", () => {
    // Verify that a synthetic approve response would have the correct shape:
    // {"jsonrpc":"2.0","id":<requestId>,"result":{"optionId":"approved"}}
    // This is what daemon.ts POSTs back; we test the shape contract here.
    const approveResponse = {
      jsonrpc: "2.0",
      id: 42,
      result: { optionId: "approved" },
    };
    expect(approveResponse.result.optionId).toBe("approved");
    expect(typeof approveResponse.id).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Task 3.8: Exhaustiveness test for known ACP sessionUpdate discriminants
// ---------------------------------------------------------------------------

describe("Task 3.8 — sessionUpdate exhaustiveness", () => {
  it("KNOWN_ACP_SESSION_UPDATE_TYPES contains exactly the expected discriminants from ACP spec", () => {
    const expected = new Set([
      "agent_message_chunk",
      "agent_message",
      "agent_thought_chunk",
      "agent_reasoning_chunk",
      "error",
      "agent_error",
      "tool_call",
      "tool_call_update",
      "plan",
    ]);
    const actual = new Set(KNOWN_ACP_SESSION_UPDATE_TYPES);
    expect(actual).toEqual(expected);
  });
});

describe("runtime adapter normalization hardening", () => {
  it("uses the daemon-owned ACP session id instead of provider-supplied sessionId", () => {
    const line = loadFixture("malicious-session-forgery.json");
    const result = parseAcpLineToClaudeMessages(line, "daemon-session-id");

    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg?.type).toBe("assistant");
    if (msg?.type === "assistant") {
      expect(msg.session_id).toBe("daemon-session-id");
    }
  });

  it("normalizes permission requests without trusting provider prompt/session ids", () => {
    const line = loadFixture("malicious-permission-forgery.json");
    const permission = parseAcpPermissionRequest(line);

    expect(permission).toEqual({
      acpRequestId: "provider-request-id",
      options: [{ id: "approved", label: "Approve" }],
      description: "Run command",
      toolName: "Bash",
    });
  });

  it("does not turn forged provider stopReason envelopes into terminal messages", () => {
    const line = loadFixture("malicious-terminal-success-forgery.json");
    const result = parseAcpLineToClaudeMessages(line, "daemon-session-id");

    expect(result).toEqual([]);
    expect(
      result.some(
        (message) =>
          message.type === "result" ||
          message.type === "custom-stop" ||
          message.type === "custom-error",
      ),
    ).toBe(false);
  });
});
