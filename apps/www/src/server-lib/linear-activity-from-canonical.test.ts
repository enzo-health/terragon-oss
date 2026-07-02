import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { DBMessage } from "@terragon/shared";
import { deriveDBMessagesFromCanonical } from "@terragon/shared/model/derive-db-messages-from-canonical";
import { describe, expect, it } from "vitest";
import {
  extractLastAssistantTextFromDBMessages,
  extractLatestAgentPlanFromDBMessages,
  LINEAR_ACTIVITY_SUMMARY_MAX_CHARS,
} from "./linear-activity-from-canonical";

const baseEnvelope = (seq: number) => ({
  payloadVersion: 2 as const,
  eventId: `event-${seq}`,
  runId: "run-1",
  threadId: "thread-1",
  threadChatId: "thread-chat-1",
  seq,
  timestamp: "2026-07-02T00:00:00.000Z",
});

const assistantMessageEvent = (
  seq: number,
  content: string,
): CanonicalEvent => ({
  ...baseEnvelope(seq),
  category: "transcript",
  type: "assistant-message",
  messageId: `message-${seq}`,
  content,
});

const acpPlanEvent = (
  seq: number,
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>,
): CanonicalEvent => ({
  ...baseEnvelope(seq),
  category: "artifact",
  type: "provider-rich-part",
  richKind: "acp-plan",
  payload: { entries },
});

const agentText = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "text", text }],
});

const agentPlan = (
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed" | "failed";
  }>,
): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "plan", entries }],
});

describe("linear-activity-from-canonical extraction", () => {
  it("derives last assistant text and latest plan from a projected canonical batch", () => {
    const canonicalEvents: CanonicalEvent[] = [
      assistantMessageEvent(1, "First narration line."),
      acpPlanEvent(2, [
        { content: "Investigate", priority: "high", status: "completed" },
        { content: "Fix", priority: "medium", status: "in_progress" },
        { content: "Verify", priority: "low", status: "pending" },
      ]),
      assistantMessageEvent(3, "Latest narration line."),
    ];

    const projected = deriveDBMessagesFromCanonical(canonicalEvents);

    expect(extractLastAssistantTextFromDBMessages(projected)).toBe(
      "Latest narration line.",
    );
    expect(extractLatestAgentPlanFromDBMessages(projected)).toEqual([
      { content: "Investigate", status: "completed" },
      { content: "Fix", status: "inProgress" },
      { content: "Verify", status: "pending" },
    ]);
  });

  it("returns the most recent non-empty agent text, skipping later non-text agent messages", () => {
    const messages: DBMessage[] = [
      agentText("earlier"),
      agentText("target"),
      agentPlan([{ content: "step", priority: "high", status: "pending" }]),
    ];
    expect(extractLastAssistantTextFromDBMessages(messages)).toBe("target");
  });

  it("skips blank agent text parts", () => {
    const messages: DBMessage[] = [agentText("real"), agentText("   ")];
    expect(extractLastAssistantTextFromDBMessages(messages)).toBe("real");
  });

  it("truncates assistant text to the summary max length", () => {
    const long = "x".repeat(LINEAR_ACTIVITY_SUMMARY_MAX_CHARS + 50);
    const result = extractLastAssistantTextFromDBMessages([agentText(long)]);
    expect(result).toHaveLength(LINEAR_ACTIVITY_SUMMARY_MAX_CHARS);
  });

  it("returns null when no agent message carries text", () => {
    const messages: DBMessage[] = [
      {
        type: "tool-call",
        id: "t1",
        name: "Bash",
        parameters: {},
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "t1",
        is_error: false,
        result: "ok",
        parent_tool_use_id: null,
      },
      agentPlan([{ content: "step", priority: "high", status: "pending" }]),
    ];
    expect(extractLastAssistantTextFromDBMessages(messages)).toBeNull();
  });

  it("returns the latest plan when multiple plans are present", () => {
    const messages: DBMessage[] = [
      agentPlan([{ content: "old", priority: "high", status: "completed" }]),
      agentPlan([{ content: "new", priority: "high", status: "in_progress" }]),
    ];
    expect(extractLatestAgentPlanFromDBMessages(messages)).toEqual([
      { content: "new", status: "inProgress" },
    ]);
  });

  it("maps unknown plan statuses (e.g. failed) to pending", () => {
    const messages: DBMessage[] = [
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [
          {
            type: "plan",
            entries: [{ content: "broke", priority: "high", status: "failed" }],
          },
        ],
      },
    ];
    expect(extractLatestAgentPlanFromDBMessages(messages)).toEqual([
      { content: "broke", status: "pending" },
    ]);
  });

  it("returns null when no plan part is present", () => {
    expect(
      extractLatestAgentPlanFromDBMessages([agentText("no plan here")]),
    ).toBeNull();
  });
});
