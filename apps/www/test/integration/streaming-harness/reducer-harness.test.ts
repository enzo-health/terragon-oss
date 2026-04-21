import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import {
  textStart,
  textContent,
  textEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  customRichPart,
} from "../ag-ui-replayer";
import { runReducerHarness, printTimingSummary } from "./reducer-harness";

describe("reducer harness", () => {
  describe("correctness", () => {
    it("handles a simple text message turn", () => {
      const events = [
        textStart("msg-1"),
        textContent("msg-1", "Hello "),
        textContent("msg-1", "world"),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events);

      expect(result.finalMessages).toHaveLength(1);
      expect(result.finalMessages[0]!.role).toBe("agent");
      const msg = result.finalMessages[0]!;
      if (msg.role === "agent") {
        expect(msg.parts).toHaveLength(1);
        expect(msg.parts[0]).toMatchObject({
          type: "text",
          text: "Hello world",
        });
      }
    });

    it("handles multi-message turn with interleaved tool calls", () => {
      const events = [
        textStart("msg-1"),
        textContent("msg-1", "Let me check."),
        toolCallStart("tc-1", "readFile"),
        toolCallArgs("tc-1", '{"path":"/src/index.ts"}'),
        toolCallEnd("tc-1"),
        toolCallResult("tc-1", "file contents here"),
        textStart("msg-2"),
        textContent("msg-2", "Done."),
        textEnd("msg-2"),
      ];

      const result = runReducerHarness(events);

      expect(result.finalMessages).toHaveLength(2);

      const msg1 = result.finalMessages[0]!;
      if (msg1.role === "agent") {
        const textParts = msg1.parts.filter((p) => p.type === "text");
        const toolParts = msg1.parts.filter((p) => p.type === "tool");
        expect(textParts).toHaveLength(1);
        expect(toolParts).toHaveLength(1);
      }

      const msg2 = result.finalMessages[1]!;
      if (msg2.role === "agent") {
        expect(msg2.parts).toHaveLength(1);
        expect(msg2.parts[0]).toMatchObject({ type: "text", text: "Done." });
      }
    });

    it("handles custom rich parts (delegation)", () => {
      const events = [
        textStart("msg-1"),
        customRichPart("delegation", "msg-1", {
          type: "delegation",
          id: "del-1",
          agentName: "reviewer",
          message: "Reviewing PR",
          status: "running",
        }),
        textContent("msg-1", "Delegating review."),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events);

      expect(result.finalMessages).toHaveLength(1);
      const msg = result.finalMessages[0]!;
      if (msg.role === "agent") {
        expect(msg.parts.length).toBeGreaterThanOrEqual(2);
        const delegationPart = msg.parts.find(
          (p) => (p as Record<string, unknown>).type === "delegation",
        );
        expect(delegationPart).toBeDefined();
      }
    });

    it("handles reasoning (thinking) parts", () => {
      const events = [
        textStart("msg-1"),
        {
          type: EventType.REASONING_MESSAGE_START,
          timestamp: 0,
          messageId: "msg-1:thinking:0",
          role: "reasoning",
        } as unknown as import("@ag-ui/core").BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          timestamp: 0,
          messageId: "msg-1:thinking:0",
          delta: "Thinking about this...",
        } as unknown as import("@ag-ui/core").BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_END,
          timestamp: 0,
          messageId: "msg-1:thinking:0",
        } as unknown as import("@ag-ui/core").BaseEvent,
        textContent("msg-1", "Here is my answer."),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events);

      expect(result.finalMessages).toHaveLength(1);
      const msg = result.finalMessages[0]!;
      if (msg.role === "agent") {
        const thinkingPart = msg.parts.find((p) => p.type === "thinking");
        expect(thinkingPart).toBeDefined();
        if (thinkingPart?.type === "thinking") {
          expect(thinkingPart.thinking).toBe("Thinking about this...");
        }
      }
    });

    it("handles tool call with error result", () => {
      const events = [
        textStart("msg-1"),
        toolCallStart("tc-err", "exec"),
        toolCallArgs("tc-err", '{"cmd":"rm -rf"}'),
        toolCallEnd("tc-err"),
        toolCallResult("tc-err", "permission denied", true),
        textContent("msg-1", "That failed."),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events);

      const msg = result.finalMessages[0]!;
      if (msg.role === "agent") {
        const tool = msg.parts.find((p) => p.type === "tool");
        expect(tool).toBeDefined();
        if (tool?.type === "tool") {
          expect(tool.status).toBe("error");
        }
      }
    });

    it("preserves initial messages", () => {
      const initial = [
        {
          id: "user-1",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "Hello" }],
        },
      ];

      const events = [
        textStart("msg-1"),
        textContent("msg-1", "Hi!"),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events, { initialMessages: initial });

      expect(result.finalMessages).toHaveLength(2);
      expect(result.finalMessages[0]!.id).toBe("user-1");
      expect(result.finalMessages[1]!.id).toBe("msg-1");
    });
  });

  describe("timing", () => {
    it("records per-event timing for a small turn", () => {
      const events = [
        textStart("msg-1"),
        ...Array.from({ length: 50 }, (_, i) =>
          textContent("msg-1", `chunk-${i} `),
        ),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events);
      printTimingSummary("small-turn", result);

      expect(result.timing).toHaveLength(events.length);
      expect(result.timing.every((t) => t.durationUs >= 0)).toBe(true);
      expect(result.totalDurationMs).toBeGreaterThan(0);
      expect(result.eventsPerSecond).toBeGreaterThan(0);
    });

    it("P99 per-event stays under 1ms for 200 text deltas", () => {
      const events = [
        textStart("msg-1"),
        ...Array.from({ length: 200 }, (_, i) =>
          textContent("msg-1", `word${i} `),
        ),
        textEnd("msg-1"),
      ];

      const result = runReducerHarness(events);
      printTimingSummary("200-deltas", result);

      expect(result.p99Us).toBeLessThan(1000);
    });
  });
});
