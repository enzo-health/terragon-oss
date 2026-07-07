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

  describe("commandExecution/outputDelta item.updated", () => {
    test("streams aggregated_output as a tool-output delta keyed on the item id", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          id: "cmd1",
          type: "command_execution",
          aggregated_output: "$ npm test\nPASS\n",
          status: "in_progress",
        }),
        method: "item/commandExecution/outputDelta",
        context: makeContext(),
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "cmd1",
          partIndex: 0,
          kind: "tool-output",
          text: "$ npm test\nPASS\n",
          toolCallId: "cmd1",
          stream: "stdout",
        },
      });
    });

    test("falls back to _delta when aggregated_output is absent", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ id: "cmd2", _delta: "partial line" }),
        method: "item/commandExecution/outputDelta",
        context: makeContext(),
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "cmd2",
          partIndex: 0,
          kind: "tool-output",
          text: "partial line",
          toolCallId: "cmd2",
          stream: "stdout",
        },
      });
    });

    test("missing id or output skips", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({ type: "command_execution" }),
        method: "item/commandExecution/outputDelta",
        context: makeContext(),
      });

      expect(decision).toEqual({ kind: "skip" });
    });
  });

  describe("mcpToolCall/progress item.updated", () => {
    test("streams the progress message with a step suffix as a tool-output delta", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          id: "mcp1",
          type: "mcp_tool_call",
          status: "in_progress",
          _progress: {
            currentStep: 2,
            totalSteps: 5,
            message: "Analyzing file structure...",
          },
        }),
        method: "item/mcpToolCall/progress",
        context: makeContext(),
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "mcp1",
          partIndex: 0,
          kind: "tool-output",
          text: "Analyzing file structure... (step 2/5)",
          toolCallId: "mcp1",
          stream: "progress",
        },
      });
    });

    test("uses the step suffix alone when no message is present", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          id: "mcp2",
          type: "mcp_tool_call",
          _progress: { currentStep: 1, totalSteps: 3 },
        }),
        method: "item/mcpToolCall/progress",
        context: makeContext(),
      });

      expect(decision).toEqual({
        kind: "enqueue-delta",
        delta: {
          messageId: "mcp2",
          partIndex: 0,
          kind: "tool-output",
          text: "(step 1/3)",
          toolCallId: "mcp2",
          stream: "progress",
        },
      });
    });

    test("skips when there is no meaningful progress to stream", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          id: "mcp3",
          type: "mcp_tool_call",
          _progress: {},
        }),
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

  describe("plan item/plan/delta", () => {
    test("plan deltas are skipped in favor of the completed snapshot", () => {
      const decision = routeCodexNotification({
        threadEvent: itemUpdated({
          type: "plan",
          id: "plan-1",
          text: " more plan text",
        }),
        method: "item/plan/delta",
        context: makeContext(),
      });
      expect(decision).toEqual({ kind: "skip" });
    });

    test("completed plan item falls through to parse", () => {
      const decision = routeCodexNotification({
        threadEvent: itemCompleted({
          type: "plan",
          id: "plan-1",
          text: "- [ ] step",
        }),
        method: "item/completed",
        context: makeContext(),
      });
      expect(decision).toEqual({ kind: "flush-then-parse" });
    });
  });
});
