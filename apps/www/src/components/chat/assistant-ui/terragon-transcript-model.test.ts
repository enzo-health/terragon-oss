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

    expect(model.latestAgentMessageIndex).toBe(1);
    expect(model.hasPendingToolCall).toBe(true);
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
});
