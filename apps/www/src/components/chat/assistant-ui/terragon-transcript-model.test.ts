import type { UIMessage, UIUserMessage } from "@terragon/shared";
import { describe, expect, it } from "vitest";
import {
  buildTerragonTranscriptModel,
  createTerragonTranscriptModelBuilder,
} from "./terragon-transcript-model";

const runtimeAgentMessage: UIMessage = {
  id: "agent-1",
  role: "agent",
  agent: "codex",
  parts: [{ type: "text", text: "runtime" }],
};

describe("buildTerragonTranscriptModel", () => {
  it("derives latest agent and renderable-agent state from final transcript messages", () => {
    const optimisticMessage: UIUserMessage = {
      id: "user-optimistic-1",
      role: "user",
      parts: [{ type: "text", text: "queued" }],
      timestamp: "2026-01-01T00:00:00.000Z",
      model: null,
    };

    const model = buildTerragonTranscriptModel({
      runtimeMessages: [runtimeAgentMessage],
      optimisticUserMessages: [optimisticMessage],
    });

    expect(model.messages).toEqual([runtimeAgentMessage, optimisticMessage]);
    expect(model.latestAgentMessageIndex).toBe(0);
    expect(model.hasRenderableAgentParts).toBe(true);
    expect(model.hasPendingToolCall).toBe(false);
  });

  it("derives pending tool state from the final transcript messages", () => {
    const pendingToolMessage: UIMessage = {
      id: "agent-tool-1",
      role: "agent",
      agent: "codex",
      parts: [
        {
          type: "tool",
          id: "tool-1",
          agent: "codex",
          name: "Bash",
          parameters: {},
          status: "pending",
          parts: [],
        },
      ],
    };

    const model = buildTerragonTranscriptModel({
      runtimeMessages: [pendingToolMessage],
      optimisticUserMessages: [],
    });

    expect(model.hasRenderableAgentParts).toBe(true);
    expect(model.hasPendingToolCall).toBe(true);
  });

  it("keeps pending tool state when a later agent message is streaming", () => {
    const pendingToolMessage: UIMessage = {
      id: "agent-tool-1",
      role: "agent",
      agent: "codex",
      parts: [
        {
          type: "tool",
          id: "tool-1",
          agent: "codex",
          name: "Bash",
          parameters: {},
          status: "pending",
          parts: [],
        },
      ],
    };
    const laterTextMessage: UIMessage = {
      id: "agent-text-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "Still working" }],
    };

    const model = buildTerragonTranscriptModel({
      runtimeMessages: [pendingToolMessage, laterTextMessage],
      optimisticUserMessages: [],
    });

    expect(model.latestAgentMessageIndex).toBe(0);
    expect(model.hasPendingToolCall).toBe(true);
  });

  it("coalesces contiguous agent runtime messages into one assistant turn", () => {
    const firstTextMessage: UIMessage = {
      id: "agent-text-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "Starting" }],
    };
    const toolMessage: UIMessage = {
      id: "agent-tool-1",
      role: "agent",
      agent: "codex",
      parts: [
        {
          type: "tool",
          id: "tool-1",
          agent: "codex",
          name: "Bash",
          parameters: {},
          status: "completed",
          result: "ok",
          parts: [],
        },
      ],
    };
    const finalTextMessage: UIMessage = {
      id: "agent-text-2",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "Done" }],
    };

    const model = buildTerragonTranscriptModel({
      runtimeMessages: [firstTextMessage, toolMessage, finalTextMessage],
      optimisticUserMessages: [],
    });

    expect(model.messages).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({
      id: "agent-text-1",
      role: "agent",
      agent: "codex",
      sourceMessageIds: ["agent-text-1", "agent-tool-1", "agent-text-2"],
      parts: [
        { type: "text", text: "Starting" },
        { type: "tool", id: "tool-1" },
        { type: "text", text: "Done" },
      ],
    });
    expect(model.latestAgentMessageIndex).toBe(0);
  });

  it("builds plan occurrences from runtime-owned final transcript messages", () => {
    const runtimePlanMessage: UIMessage = {
      id: "runtime-plan",
      role: "agent",
      agent: "codex",
      parts: [
        {
          type: "text",
          text: "<proposed_plan>runtime plan</proposed_plan>",
        },
      ],
    };

    const model = buildTerragonTranscriptModel({
      runtimeMessages: [runtimePlanMessage],
      optimisticUserMessages: [],
    });

    expect(model.planOccurrencesRaw.get(runtimePlanMessage.parts[0]!)).toBe(0);
  });
});

describe("createTerragonTranscriptModelBuilder", () => {
  it("reuses the previous model when steady runtime inputs are unchanged", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const first = buildModel({
      runtimeMessages: [runtimeAgentMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [runtimeAgentMessage],
      optimisticUserMessages,
    });

    expect(second).toBe(first);
  });

  it("updates only the tail message for steady runtime streaming", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const firstMessage: UIMessage = {
      id: "agent-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "first" }],
    };
    const nextMessage: UIMessage = {
      ...firstMessage,
      parts: [{ type: "text", text: "first second" }],
    };
    const first = buildModel({
      runtimeMessages: [firstMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [nextMessage],
      optimisticUserMessages,
    });

    expect(second).not.toBe(first);
    expect(second.messages).toEqual([nextMessage]);
  });

  it("rebuilds instead of using the steady fast path when optimistic messages are present", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const firstAgentMessage: UIMessage = {
      id: "agent-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "first" }],
    };
    const tailAgentMessage: UIMessage = {
      id: "agent-2",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "second" }],
    };
    const nextTailAgentMessage: UIMessage = {
      ...tailAgentMessage,
      parts: [{ type: "text", text: "second updated" }],
    };
    const optimisticMessage: UIUserMessage = {
      id: "user-optimistic-1",
      role: "user",
      parts: [{ type: "text", text: "queued" }],
      timestamp: "2026-01-01T00:00:00.000Z",
      model: null,
    };

    buildModel({
      runtimeMessages: [firstAgentMessage, tailAgentMessage],
      optimisticUserMessages: [optimisticMessage],
    });
    const second = buildModel({
      runtimeMessages: [firstAgentMessage, nextTailAgentMessage],
      optimisticUserMessages: [optimisticMessage],
    });

    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]).toMatchObject({
      id: "agent-1",
      role: "agent",
      sourceMessageIds: ["agent-1", "agent-2"],
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "second updated" },
      ],
    });
    expect(second.messages[1]).toBe(optimisticMessage);
  });

  it("updates pending tool state when a steady tail gains a pending tool", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const firstMessage: UIMessage = {
      id: "agent-tail",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "running" }],
    };
    const nextMessage: UIMessage = {
      ...firstMessage,
      parts: [
        {
          type: "tool",
          id: "tool-1",
          agent: "codex",
          name: "Bash",
          parameters: {},
          status: "pending",
          parts: [],
        },
      ],
    };

    buildModel({
      runtimeMessages: [firstMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [nextMessage],
      optimisticUserMessages,
    });

    expect(second.hasPendingToolCall).toBe(true);
  });

  it("clears pending tool state when the steady tail completes the only pending tool", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const firstMessage: UIMessage = {
      id: "agent-tail",
      role: "agent",
      agent: "codex",
      parts: [
        {
          type: "tool",
          id: "tool-1",
          agent: "codex",
          name: "Bash",
          parameters: {},
          status: "pending",
          parts: [],
        },
      ],
    };
    const nextMessage: UIMessage = {
      ...firstMessage,
      parts: [
        {
          type: "tool",
          id: "tool-1",
          agent: "codex",
          name: "Bash",
          parameters: {},
          status: "completed",
          result: "ok",
          parts: [],
        },
      ],
    };

    buildModel({
      runtimeMessages: [firstMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [nextMessage],
      optimisticUserMessages,
    });

    expect(second.hasPendingToolCall).toBe(false);
  });

  it("keeps steady tail streaming fast when historical proposed plans exist", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const planMessage: UIMessage = {
      id: "agent-plan",
      role: "agent",
      agent: "codex",
      parts: [
        {
          type: "text",
          text: "<proposed_plan>historical plan</proposed_plan>",
        },
      ],
    };
    const firstTail: UIMessage = {
      id: "agent-tail",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "first" }],
    };
    const nextTail: UIMessage = {
      ...firstTail,
      parts: [{ type: "text", text: "first second" }],
    };
    const first = buildModel({
      runtimeMessages: [planMessage, firstTail],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [planMessage, nextTail],
      optimisticUserMessages,
    });

    expect(first.planOccurrencesRaw.size).toBe(1);
    expect(second.planOccurrencesRaw).toBe(first.planOccurrencesRaw);
    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).toBe(nextTail);
  });

  it("appends contiguous agent messages without rebuilding stable transcript rows", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const firstAgentMessage: UIMessage = {
      id: "agent-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "starting" }],
    };
    const userMessage: UIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "next" }],
    };
    const appendedAgentMessage: UIMessage = {
      id: "agent-2",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "done" }],
    };
    const first = buildModel({
      runtimeMessages: [firstAgentMessage, userMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [firstAgentMessage, userMessage, appendedAgentMessage],
      optimisticUserMessages,
    });

    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).toBe(first.messages[1]);
    expect(second.messages[2]).toBe(appendedAgentMessage);
    expect(second.planOccurrencesRaw).toBe(first.planOccurrencesRaw);
  });

  it("coalesces appended contiguous agent messages incrementally", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const firstPart = { type: "text" as const, text: "starting" };
    const firstAgentMessage: UIMessage = {
      id: "agent-1",
      role: "agent",
      agent: "codex",
      parts: [firstPart],
    };
    const appendedPart = { type: "text" as const, text: "done" };
    const appendedAgentMessage: UIMessage = {
      id: "agent-2",
      role: "agent",
      agent: "codex",
      parts: [appendedPart],
    };
    const first = buildModel({
      runtimeMessages: [firstAgentMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [firstAgentMessage, appendedAgentMessage],
      optimisticUserMessages,
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).not.toBe(first.messages[0]);
    expect(second.messages[0]).toMatchObject({
      id: "agent-1",
      role: "agent",
      sourceMessageIds: ["agent-1", "agent-2"],
      parts: [
        { type: "text", text: "starting" },
        { type: "text", text: "done" },
      ],
    });
    expect(
      second.messages[0]?.role === "agent" && second.messages[0].parts[0],
    ).toBe(firstPart);
    expect(
      second.messages[0]?.role === "agent" && second.messages[0].parts[1],
    ).toBe(appendedPart);
    expect(second.planOccurrencesRaw).toBe(first.planOccurrencesRaw);
  });

  it("updates coalesced live agent tails without rebuilding stable parts", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const staticTextPart = { type: "text" as const, text: "starting" };
    const toolPart = {
      type: "tool" as const,
      id: "tool-1",
      agent: "codex" as const,
      name: "Bash",
      parameters: {},
      status: "completed" as const,
      result: "ok",
      parts: [],
    };
    const firstAgentMessage: UIMessage = {
      id: "agent-1",
      role: "agent",
      agent: "codex",
      parts: [staticTextPart],
    };
    const toolMessage: UIMessage = {
      id: "agent-2",
      role: "agent",
      agent: "codex",
      parts: [toolPart],
    };
    const firstTailPart = { type: "text" as const, text: "tail" };
    const firstTail: UIMessage = {
      id: "agent-3",
      role: "agent",
      agent: "codex",
      parts: [firstTailPart],
    };
    const nextTailPart = { type: "text" as const, text: "tail updated" };
    const nextTail: UIMessage = {
      ...firstTail,
      parts: [nextTailPart],
    };
    const first = buildModel({
      runtimeMessages: [firstAgentMessage, toolMessage, firstTail],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [firstAgentMessage, toolMessage, nextTail],
      optimisticUserMessages,
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).not.toBe(first.messages[0]);
    if (second.messages[0]?.role !== "agent") {
      throw new Error("expected coalesced agent message");
    }
    expect(second.messages[0].parts).toHaveLength(3);
    expect(second.messages[0].parts[0]).toBe(staticTextPart);
    expect(second.messages[0].parts[1]).toBe(toolPart);
    expect(second.messages[0].parts[2]).toBe(nextTailPart);
    expect(second.planOccurrencesRaw).toBe(first.planOccurrencesRaw);
  });

  it("falls back when appended runtime messages contain proposed plans", () => {
    const buildModel = createTerragonTranscriptModelBuilder();
    const optimisticUserMessages: UIUserMessage[] = [];
    const firstAgentMessage: UIMessage = {
      id: "agent-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "starting" }],
    };
    const planPart = {
      type: "text" as const,
      text: "<proposed_plan>new plan</proposed_plan>",
    };
    const planMessage: UIMessage = {
      id: "agent-plan",
      role: "agent",
      agent: "codex",
      parts: [planPart],
    };
    const first = buildModel({
      runtimeMessages: [firstAgentMessage],
      optimisticUserMessages,
    });
    const second = buildModel({
      runtimeMessages: [firstAgentMessage, planMessage],
      optimisticUserMessages,
    });

    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).toBe(planMessage);
    expect(second.planOccurrencesRaw).not.toBe(first.planOccurrencesRaw);
    expect(second.planOccurrencesRaw.get(planPart)).toBe(0);
  });
});
