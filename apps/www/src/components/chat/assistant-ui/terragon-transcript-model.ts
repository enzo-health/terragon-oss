"use client";

import type { UIMessage, UIUserMessage, UIPart } from "@terragon/shared";
import { buildThreadPlanOccurrenceMap } from "./plan-occurrences";
import {
  tryBuildAppendedRuntimeModel,
  tryBuildSteadyCoalescedRuntimeModel,
  tryBuildSteadyRuntimeModel,
} from "./terragon-transcript-incremental";

const EMPTY_PLAN_OCCURRENCES = new Map<UIPart, number>();
export type AgentUIMessage = Extract<UIMessage, { role: "agent" }>;

export type TerragonTranscriptModel = {
  messages: UIMessage[];
  latestAgentMessageIndex: number;
  hasRenderableAgentParts: boolean;
  hasPendingToolCall: boolean;
  planOccurrencesRaw: Map<UIPart, number>;
};

export type BuildTerragonTranscriptModelInput = {
  runtimeMessages: UIMessage[];
  optimisticUserMessages: UIUserMessage[];
};

export function createTerragonTranscriptModelBuilder() {
  let previousInput: BuildTerragonTranscriptModelInput | null = null;
  let previousModel: TerragonTranscriptModel | null = null;

  return (
    input: BuildTerragonTranscriptModelInput,
  ): TerragonTranscriptModel => {
    const steadyRuntimeModel =
      tryBuildSteadyRuntimeModel({
        input,
        previousInput,
        previousModel,
      }) ??
      tryBuildAppendedRuntimeModel({
        input,
        previousInput,
        previousModel,
      }) ??
      tryBuildSteadyCoalescedRuntimeModel({
        input,
        previousInput,
        previousModel,
      });
    const model = steadyRuntimeModel ?? buildTerragonTranscriptModel(input);
    previousInput = input;
    previousModel = model;
    return model;
  };
}

export function buildTerragonTranscriptModel({
  runtimeMessages,
  optimisticUserMessages,
}: BuildTerragonTranscriptModelInput): TerragonTranscriptModel {
  const messages = coalesceContiguousAgentMessages(
    appendOptimisticUserMessages(runtimeMessages, optimisticUserMessages),
  );

  const facts = deriveTranscriptFacts(messages);

  return {
    messages,
    ...facts,
    planOccurrencesRaw: messagesMayContainProposedPlan(messages)
      ? buildThreadPlanOccurrenceMap(messages)
      : EMPTY_PLAN_OCCURRENCES,
  };
}

function coalesceContiguousAgentMessages(messages: UIMessage[]): UIMessage[] {
  let didCoalesce = false;
  const coalesced: UIMessage[] = [];

  for (const message of messages) {
    const previous = coalesced.at(-1);
    if (
      previous?.role === "agent" &&
      message.role === "agent" &&
      canCoalesceAgentMessages(previous, message)
    ) {
      didCoalesce = true;
      coalesced[coalesced.length - 1] = coalesceAgentMessages(
        previous,
        message,
      );
      continue;
    }

    coalesced.push(message);
  }

  return didCoalesce ? coalesced : messages;
}

export function canCoalesceAgentMessages(
  previous: AgentUIMessage,
  message: AgentUIMessage,
): boolean {
  return (
    previous.agent === message.agent &&
    !messageMayContainProposedPlan(previous) &&
    !messageMayContainProposedPlan(message)
  );
}

export function coalesceAgentMessages(
  previous: AgentUIMessage,
  message: AgentUIMessage,
): AgentUIMessage {
  return {
    ...previous,
    parts: [...previous.parts, ...message.parts],
    sourceMessageIds: [
      ...(previous.sourceMessageIds ?? [previous.id]),
      ...(message.sourceMessageIds ?? [message.id]),
    ],
    meta: message.meta ?? previous.meta,
  };
}

export function deriveTranscriptFacts(
  messages: UIMessage[],
): Pick<
  TerragonTranscriptModel,
  "latestAgentMessageIndex" | "hasRenderableAgentParts" | "hasPendingToolCall"
> {
  let latestAgentMessageIndex = -1;
  let hasRenderableAgentParts = false;
  let hasPendingToolCall = false;

  messages.forEach((message, index) => {
    if (message.role === "agent") {
      latestAgentMessageIndex = index;
      if (messageHasRenderableAgentParts(message)) {
        hasRenderableAgentParts = true;
      }
      if (messageHasPendingToolCall(message)) {
        hasPendingToolCall = true;
      }
    }
  });
  return {
    latestAgentMessageIndex,
    hasRenderableAgentParts,
    hasPendingToolCall,
  };
}

export function messageHasRenderableAgentParts(message: UIMessage): boolean {
  return message.role === "agent" && message.parts.length > 0;
}

export function messageHasPendingToolCall(message: UIMessage): boolean {
  return (
    message.role === "agent" &&
    message.parts.some(
      (part) => part.type === "tool" && part.status === "pending",
    )
  );
}

function messagesMayContainProposedPlan(messages: UIMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "agent" && partsMayContainProposedPlan(message.parts),
  );
}

export function messageMayContainProposedPlan(message: UIMessage): boolean {
  return message.role === "agent" && partsMayContainProposedPlan(message.parts);
}

function partsMayContainProposedPlan(parts: UIPart[]): boolean {
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.includes("<proposed_plan")) {
        return true;
      }
      continue;
    }

    if (part.type === "tool" && "parts" in part) {
      if (partsMayContainProposedPlan(part.parts)) {
        return true;
      }
    }
  }
  return false;
}

function appendOptimisticUserMessages(
  messages: UIMessage[],
  optimisticUserMessages: UIUserMessage[],
): UIMessage[] {
  if (optimisticUserMessages.length === 0) {
    return messages;
  }

  let nextMessages: UIMessage[] | null = null;
  for (const optimisticMessage of optimisticUserMessages) {
    const existingMessages: UIMessage[] = nextMessages ?? messages;
    const duplicate = existingMessages.some((message) =>
      isSameUserMessage(message, optimisticMessage),
    );
    if (duplicate) {
      continue;
    }
    nextMessages = [...existingMessages, optimisticMessage];
  }

  return nextMessages ?? messages;
}

function isSameUserMessage(
  message: UIMessage,
  optimisticMessage: UIUserMessage,
): boolean {
  return (
    message.role === "user" &&
    message.parts.length === optimisticMessage.parts.length &&
    message.parts.every((part, index) =>
      isSameUserMessagePart(part, optimisticMessage.parts[index]),
    )
  );
}

function isSameUserMessagePart(
  part: UIUserMessage["parts"][number],
  optimisticPart: UIUserMessage["parts"][number] | undefined,
): boolean {
  return (
    optimisticPart !== undefined &&
    JSON.stringify(part) === JSON.stringify(optimisticPart)
  );
}
