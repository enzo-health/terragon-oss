import { EventType, type BaseEvent } from "@ag-ui/core";
import type { UIMessage } from "@terragon/shared";
import { describe, expect, it } from "vitest";
import {
  agUiMessagesReducer,
  createInitialAgUiMessagesState,
  type AgUiMessagesState,
} from "./ag-ui-messages-reducer";

function mkState(initial: UIMessage[] = []): AgUiMessagesState {
  return createInitialAgUiMessagesState("claudeCode", initial);
}

function apply(
  state: AgUiMessagesState,
  events: BaseEvent[],
): AgUiMessagesState {
  return events.reduce((s, e) => agUiMessagesReducer(s, e), state);
}

describe("agUiMessagesReducer", () => {
  describe("TEXT_MESSAGE events", () => {
    it("TEXT_MESSAGE_START creates an assistant message with empty parts", () => {
      const next = apply(mkState(), [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "m1",
          role: "assistant",
        } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({
        id: "m1",
        role: "agent",
        agent: "claudeCode",
        parts: [],
      });
      expect(next.activeAssistantMessageId).toBe("m1");
    });

    it("START + CONTENT + END produces an assistant message with a single text part", () => {
      const next = apply(mkState(), [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "hello",
        } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([{ type: "text", text: "hello" }]);
    });

    it("two CONTENT deltas concatenate onto the same text part", () => {
      const next = apply(mkState(), [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "hel",
        } as BaseEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "lo",
        } as BaseEvent,
      ]);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([{ type: "text", text: "hello" }]);
    });

    it("CONTENT without a preceding START still creates the message (reconnect tolerance)", () => {
      const next = apply(mkState(), [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m42",
          delta: "orphan",
        } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({
        id: "m42",
        role: "agent",
      });
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([{ type: "text", text: "orphan" }]);
    });
  });

  describe("REASONING (thinking) events", () => {
    it("REASONING_MESSAGE_START creates an assistant message with a thinking part", () => {
      const next = apply(mkState(), [
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "m1:thinking:0",
        } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([{ type: "thinking", thinking: "" }]);
    });

    it("REASONING START + CONTENT + END appends thinking text", () => {
      const next = apply(mkState(), [
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "m1:thinking:0",
        } as BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "m1:thinking:0",
          delta: "pondering",
        } as BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_END,
          messageId: "m1:thinking:0",
        } as BaseEvent,
      ]);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([{ type: "thinking", thinking: "pondering" }]);
    });

    it("two reasoning parts on the same message are kept distinct by partIndex", () => {
      const next = apply(mkState(), [
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "m1:thinking:0",
        } as BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "m1:thinking:0",
          delta: "first",
        } as BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "m1:thinking:1",
        } as BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "m1:thinking:1",
          delta: "second",
        } as BaseEvent,
      ]);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([
        { type: "thinking", thinking: "first" },
        { type: "thinking", thinking: "second" },
      ]);
    });

    it("reasoning messageId without the :thinking: marker is ignored", () => {
      const state = mkState();
      const next = agUiMessagesReducer(state, {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "malformed-id",
      } as BaseEvent);
      expect(next).toBe(state);
    });
  });

  describe("TOOL_CALL events", () => {
    it("START + ARGS + END + RESULT produces a completed tool part", () => {
      const next = apply(mkState(), [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "t1",
          toolCallName: "Read",
        } as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "t1",
          delta: '{"file_path":"/tmp/a"}',
        } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "t1",
          content: "file contents",
        } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toEqual([
        {
          type: "tool",
          id: "t1",
          agent: "claudeCode",
          name: "Read",
          parameters: { file_path: "/tmp/a" },
          status: "completed",
          parts: [],
          result: "file contents",
        },
      ]);
    });

    it("TOOL_CALL_RESULT with role:tool marks the tool as error", () => {
      const next = apply(mkState(), [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "t1",
          toolCallName: "Bash",
        } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "t1",
          content: "boom",
          role: "tool",
        } as BaseEvent,
      ]);
      const parts = (next.messages[0] as { parts: Array<{ status: string }> })
        .parts;
      expect(parts[0]).toMatchObject({ status: "error", result: "boom" });
    });

    it("TOOL_CALL_ARGS accumulates incremental JSON chunks", () => {
      const next = apply(mkState(), [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "t1",
          toolCallName: "Grep",
        } as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "t1",
          delta: '{"pattern":',
        } as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "t1",
          delta: '"foo"}',
        } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
      ]);
      const parts = (
        next.messages[0] as { parts: Array<{ parameters: unknown }> }
      ).parts;
      expect(parts[0]!.parameters).toEqual({ pattern: "foo" });
    });

    it("tool call without a preceding text message still renders on a synthetic assistant message", () => {
      const next = apply(mkState(), [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "t1",
          toolCallName: "Read",
        } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]!.role).toBe("agent");
      const parts = (next.messages[0] as { parts: Array<{ id: string }> })
        .parts;
      expect(parts[0]!.id).toBe("t1");
    });
  });

  describe("CUSTOM terragon.part events", () => {
    it("CUSTOM terragon.part.terminal appends the part to the matching assistant message", () => {
      const next = apply(mkState(), [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
        {
          type: EventType.CUSTOM,
          name: "terragon.part.terminal",
          value: {
            messageId: "m1",
            partIndex: 1,
            part: {
              type: "terminal",
              terminal: { command: "ls", output: "README.md\n" },
            },
          },
        } as BaseEvent,
      ]);
      const parts = (next.messages[0] as { parts: Array<{ type: string }> })
        .parts;
      expect(parts).toHaveLength(1);
      expect(parts[0]!.type).toBe("terminal");
    });

    it("CUSTOM terragon.part.* creates the assistant message if it doesn't exist yet", () => {
      const next = apply(mkState(), [
        {
          type: EventType.CUSTOM,
          name: "terragon.part.diff",
          value: {
            messageId: "m-replay",
            partIndex: 0,
            part: { type: "diff", diff: "diff-body" },
          },
        } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]!.id).toBe("m-replay");
      const parts = (next.messages[0] as { parts: Array<{ type: string }> })
        .parts;
      expect(parts[0]!.type).toBe("diff");
    });

    it("CUSTOM with unknown name is ignored", () => {
      const state = mkState();
      const next = agUiMessagesReducer(state, {
        type: EventType.CUSTOM,
        name: "some.other.thing",
        value: { messageId: "m1", partIndex: 0, part: { type: "x" } },
      } as BaseEvent);
      expect(next).toBe(state);
    });

    it("CUSTOM terragon.part.* without a part value is ignored", () => {
      const state = mkState();
      const next = agUiMessagesReducer(state, {
        type: EventType.CUSTOM,
        name: "terragon.part.image",
        value: { messageId: "m1", partIndex: 0 },
      } as BaseEvent);
      expect(next).toBe(state);
    });
  });

  describe("initial state + misc", () => {
    it("pre-existing initialMessages are preserved; new events append after them", () => {
      const initial: UIMessage[] = [
        {
          id: "user-0",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      ];
      const next = apply(mkState(initial), [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "agent-1",
        } as BaseEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "agent-1",
          delta: "hello back",
        } as BaseEvent,
      ]);
      expect(next.messages).toHaveLength(2);
      expect(next.messages[0]!.id).toBe("user-0");
      expect(next.messages[1]!.id).toBe("agent-1");
    });

    it("unknown event types leave state unchanged (reference-equal)", () => {
      const state = mkState();
      const next = agUiMessagesReducer(state, {
        type: EventType.RUN_STARTED,
        threadId: "t",
        runId: "r",
      } as BaseEvent);
      expect(next).toBe(state);
    });

    it("duplicate CUSTOM rich-parts with the same id don't double-insert", () => {
      const state = mkState();
      const customEvent = {
        type: EventType.CUSTOM,
        name: "terragon.part.auto-approval-review",
        value: {
          messageId: "m1",
          partIndex: 0,
          part: {
            type: "auto-approval-review",
            id: "review-1",
            decision: "approved",
          },
        },
      } as BaseEvent;
      const next = apply(state, [customEvent, customEvent]);
      const parts = (next.messages[0] as { parts: unknown[] }).parts;
      expect(parts).toHaveLength(1);
    });
  });
});
