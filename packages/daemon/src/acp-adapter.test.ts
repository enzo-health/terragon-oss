import { describe, it, expect } from "vitest";
import {
  parseAcpLineToClaudeMessages,
  coalesceAssistantTextMessages,
} from "./acp-adapter";
import { ClaudeMessage } from "./shared";

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
