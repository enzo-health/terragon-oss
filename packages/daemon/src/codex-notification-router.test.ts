import { describe, expect, test } from "vitest";
import type { DaemonCodexEvent } from "./codex-app-server";
import {
  type CodexNotificationContext,
  routeCodexNotification,
} from "./codex-notification-router";

function makeContext(): CodexNotificationContext {
  return {
    agentMessageTextById: new Map<string, string>(),
    reasoningTextById: new Map<string, string>(),
  };
}

function itemUpdated(item: Record<string, unknown>): DaemonCodexEvent {
  return { type: "item.updated", item } as unknown as DaemonCodexEvent;
}

function itemCompleted(item: Record<string, unknown>): DaemonCodexEvent {
  return { type: "item.completed", item } as unknown as DaemonCodexEvent;
}

describe("routeCodexNotification", () => {
  describe("agent_message item.updated", () => {
    test("cumulative update emits only the new tail and stores full text", () => {
      const context = makeContext();
      context.agentMessageTextById.set("m1", "Hello");

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          type: "agent_message",
          id: "m1",
          text: "Hello world",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "m1",
          partIndex: 0,
          kind: "text",
          text: " world",
        },
      });
      expect(context.agentMessageTextById.get("m1")).toBe("Hello world");
    });

    test("cumulative update that diverges sends the full text as the delta", () => {
      const context = makeContext();
      context.agentMessageTextById.set("m1", "Hello");

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          type: "agent_message",
          id: "m1",
          text: "Different",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "m1",
          partIndex: 0,
          kind: "text",
          text: "Different",
        },
      });
      expect(context.agentMessageTextById.get("m1")).toBe("Different");
    });

    test("explicit-delta method treats text as a delta and appends to accumulator", () => {
      const context = makeContext();
      context.agentMessageTextById.set("m1", "Hello");

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          type: "agent_message",
          id: "m1",
          text: " world",
        }),
        method: "item/agentMessage/delta",
        context,
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "m1",
          partIndex: 0,
          kind: "text",
          text: " world",
        },
      });
      expect(context.agentMessageTextById.get("m1")).toBe("Hello world");
    });

    test("empty resulting delta skips without enqueue", () => {
      const context = makeContext();
      context.agentMessageTextById.set("m1", "Hello");

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          type: "agent_message",
          id: "m1",
          text: "Hello",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({ kind: "skip" });
      expect(context.agentMessageTextById.get("m1")).toBe("Hello");
    });

    test("missing id or text skips (no accumulation)", () => {
      const context = makeContext();

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ type: "agent_message", id: "m1" }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({ kind: "skip" });
      expect(context.agentMessageTextById.has("m1")).toBe(false);
    });
  });

  describe("reasoning item.updated", () => {
    test("accumulates text and enqueues a thinking delta", () => {
      const context = makeContext();
      context.reasoningTextById.set("r1", "abc");

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ type: "reasoning", id: "r1", text: "def" }),
        method: "item/reasoning/textDelta",
        context,
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "r1",
          partIndex: 0,
          kind: "thinking",
          text: "def",
        },
      });
      expect(context.reasoningTextById.get("r1")).toBe("abcdef");
    });

    test("summaryPartAdded method is also treated as a reasoning delta", () => {
      const context = makeContext();

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ type: "reasoning", id: "r1", text: "hi" }),
        method: "item/reasoning/summaryPartAdded",
        context,
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "r1",
          partIndex: 0,
          kind: "thinking",
          text: "hi",
        },
      });
      expect(context.reasoningTextById.get("r1")).toBe("hi");
    });
  });

  describe("fileChange/outputDelta item.updated", () => {
    test("enqueues the _delta as a text delta", () => {
      const context = makeContext();

      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ id: "f1", _delta: "+ line" }),
        method: "item/fileChange/outputDelta",
        context,
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "f1",
          partIndex: 0,
          kind: "text",
          text: "+ line",
        },
      });
    });

    test("missing _delta skips", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ id: "f1" }),
        method: "item/fileChange/outputDelta",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "skip" });
    });
  });

  describe("skip cases", () => {
    test("commandExecution/outputDelta skips", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ id: "c1", _delta: "out" }),
        method: "item/commandExecution/outputDelta",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "skip" });
    });

    test("mcpToolCall/progress skips regardless of event type", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ id: "t1", type: "mcp_tool_call" }),
        method: "item/mcpToolCall/progress",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "skip" });
    });
  });

  describe("item.completed flush", () => {
    test("agent_message with prior stream flushes only the tail", () => {
      const context = makeContext();
      context.agentMessageTextById.set("m1", "Hello");

      const decision = routeCodexNotification({
        threadEvent: itemCompleted({
          type: "agent_message",
          id: "m1",
          text: "Hello world",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({
        kind: "flush-then-parse",
        delta: {
          messageId: "m1",
          partIndex: 0,
          kind: "text",
          text: " world",
        },
      });
      expect(context.agentMessageTextById.has("m1")).toBe(false);
    });

    test("agent_message with no prior stream flushes the full text", () => {
      const context = makeContext();

      const decision = routeCodexNotification({
        threadEvent: itemCompleted({
          type: "agent_message",
          id: "m1",
          text: "Full text",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({
        kind: "flush-then-parse",
        delta: {
          messageId: "m1",
          partIndex: 0,
          kind: "text",
          text: "Full text",
        },
      });
      expect(context.agentMessageTextById.has("m1")).toBe(false);
    });

    test("agent_message that diverged from the stream flushes nothing but still parses", () => {
      const context = makeContext();
      context.agentMessageTextById.set("m1", "Hello");

      const decision = routeCodexNotification({
        threadEvent: itemCompleted({
          type: "agent_message",
          id: "m1",
          text: "Different",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({ kind: "flush-then-parse" });
      expect(context.agentMessageTextById.has("m1")).toBe(false);
    });

    test("reasoning completed flushes the tail as a thinking delta", () => {
      const context = makeContext();
      context.reasoningTextById.set("r1", "abc");

      const decision = routeCodexNotification({
        threadEvent: itemCompleted({
          type: "reasoning",
          id: "r1",
          text: "abcdef",
        }),
        method: "thread/event",
        context,
      });

      expect(decision).toEqual({
        kind: "flush-then-parse",
        delta: {
          messageId: "r1",
          partIndex: 0,
          kind: "thinking",
          text: "def",
        },
      });
      expect(context.reasoningTextById.has("r1")).toBe(false);
    });

    test("non-streamed item type completes as plain flush-then-parse", () => {
      const decision = routeCodexNotification({
        threadEvent: itemCompleted({
          type: "command_execution",
          id: "c1",
          text: "ignored",
        }),
        method: "thread/event",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "flush-then-parse" });
    });
  });

  describe("default parse", () => {
    test("turn lifecycle events fall through to parse", () => {
      const decision = routeCodexNotification({
        threadEvent: { type: "turn.completed" } as unknown as DaemonCodexEvent,
        method: "thread/event",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "parse" });
    });

    test("item.started falls through to parse", () => {
      const decision = routeCodexNotification({
        threadEvent: {
          type: "item.started",
          item: { type: "agent_message", id: "x", text: "hi" },
        } as unknown as DaemonCodexEvent,
        method: "thread/event",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "parse" });
    });
  });
});
