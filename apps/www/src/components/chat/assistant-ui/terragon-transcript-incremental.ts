"use client";

import type { UIMessage } from "@terragon/shared";
import {
  canCoalesceAgentMessages,
  coalesceAgentMessages,
  deriveTranscriptFacts,
  messageHasPendingToolCall,
  messageHasRenderableAgentParts,
  messageMayContainProposedPlan,
  type AgentUIMessage,
  type BuildTranscriptDisplayModelInput,
  type TranscriptDisplayModel,
} from "./transcript-display-model";

type SteadyFastPathContext = {
  input: BuildTranscriptDisplayModelInput;
  previousInput: BuildTranscriptDisplayModelInput;
  previousModel: TranscriptDisplayModel;
};

function resolveSteadyFastPathContext({
  input,
  previousInput,
  previousModel,
}: {
  input: BuildTranscriptDisplayModelInput;
  previousInput: BuildTranscriptDisplayModelInput | null;
  previousModel: TranscriptDisplayModel | null;
}): SteadyFastPathContext | null {
  if (
    !previousInput ||
    !previousModel ||
    input.optimisticUserMessages.length > 0 ||
    input.optimisticUserMessages !== previousInput.optimisticUserMessages
  ) {
    return null;
  }
  return { input, previousInput, previousModel };
}

function runtimePrefixUnchanged(
  input: BuildTranscriptDisplayModelInput,
  previousInput: BuildTranscriptDisplayModelInput,
  prefixLength: number,
): boolean {
  for (let index = 0; index < prefixLength; index += 1) {
    if (input.runtimeMessages[index] !== previousInput.runtimeMessages[index]) {
      return false;
    }
  }
  return true;
}

export function tryBuildSteadyRuntimeModel(args: {
  input: BuildTranscriptDisplayModelInput;
  previousInput: BuildTranscriptDisplayModelInput | null;
  previousModel: TranscriptDisplayModel | null;
}): TranscriptDisplayModel | null {
  const context = resolveSteadyFastPathContext(args);
  if (!context) {
    return null;
  }
  const { input, previousInput, previousModel } = context;
  if (
    input.runtimeMessages.length === 0 ||
    input.runtimeMessages.length !== previousInput.runtimeMessages.length ||
    input.runtimeMessages.length !== previousModel.messages.length
  ) {
    return null;
  }

  const tailIndex = input.runtimeMessages.length - 1;
  if (!runtimePrefixUnchanged(input, previousInput, tailIndex)) {
    return null;
  }

  const previousTail = previousInput.runtimeMessages[tailIndex];
  const nextTail = input.runtimeMessages[tailIndex];
  if (
    !previousTail ||
    !nextTail ||
    previousTail.id !== nextTail.id ||
    previousTail.role !== nextTail.role ||
    messageMayContainProposedPlan(nextTail)
  ) {
    return null;
  }
  if (previousTail === nextTail) {
    return previousModel;
  }

  const messages = previousModel.messages.slice();
  messages[tailIndex] = nextTail;
  const facts = deriveSteadyTailTranscriptFacts({
    previousModel,
    previousTail,
    nextTail,
    tailIndex,
    messages,
  });
  return {
    messages,
    ...facts,
    planOccurrencesRaw: previousModel.planOccurrencesRaw,
  };
}

export function tryBuildAppendedRuntimeModel(args: {
  input: BuildTranscriptDisplayModelInput;
  previousInput: BuildTranscriptDisplayModelInput | null;
  previousModel: TranscriptDisplayModel | null;
}): TranscriptDisplayModel | null {
  const context = resolveSteadyFastPathContext(args);
  if (!context) {
    return null;
  }
  const { input, previousInput, previousModel } = context;
  if (
    input.runtimeMessages.length <= previousInput.runtimeMessages.length ||
    !runtimePrefixUnchanged(
      input,
      previousInput,
      previousInput.runtimeMessages.length,
    )
  ) {
    return null;
  }

  const appendedMessages = input.runtimeMessages.slice(
    previousInput.runtimeMessages.length,
  );
  if (appendedMessages.some(messageMayContainProposedPlan)) {
    return null;
  }

  const messages = previousModel.messages.slice();
  let latestAgentMessageIndex = previousModel.latestAgentMessageIndex;
  let hasRenderableAgentParts = previousModel.hasRenderableAgentParts;
  let hasPendingToolCall = previousModel.hasPendingToolCall;

  for (const message of appendedMessages) {
    const changedIndex = appendRuntimeMessageToTranscript(messages, message);
    const transcriptMessage = messages[changedIndex]!;
    if (transcriptMessage.role === "agent") {
      latestAgentMessageIndex = changedIndex;
      hasRenderableAgentParts =
        hasRenderableAgentParts ||
        messageHasRenderableAgentParts(transcriptMessage);
      hasPendingToolCall =
        hasPendingToolCall || messageHasPendingToolCall(transcriptMessage);
    }
  }

  return {
    messages,
    latestAgentMessageIndex,
    hasRenderableAgentParts,
    hasPendingToolCall,
    planOccurrencesRaw: previousModel.planOccurrencesRaw,
  };
}

export function tryBuildSteadyCoalescedRuntimeModel(args: {
  input: BuildTranscriptDisplayModelInput;
  previousInput: BuildTranscriptDisplayModelInput | null;
  previousModel: TranscriptDisplayModel | null;
}): TranscriptDisplayModel | null {
  const context = resolveSteadyFastPathContext(args);
  if (!context) {
    return null;
  }
  const { input, previousInput, previousModel } = context;
  if (
    input.runtimeMessages.length === 0 ||
    input.runtimeMessages.length !== previousInput.runtimeMessages.length ||
    input.runtimeMessages.length <= previousModel.messages.length
  ) {
    return null;
  }

  const tailRuntimeIndex = input.runtimeMessages.length - 1;
  if (!runtimePrefixUnchanged(input, previousInput, tailRuntimeIndex)) {
    return null;
  }

  const previousTail = previousInput.runtimeMessages[tailRuntimeIndex];
  const nextTail = input.runtimeMessages[tailRuntimeIndex];
  const previousCoalescedTail = previousModel.messages.at(-1);
  if (
    !previousTail ||
    !nextTail ||
    !previousCoalescedTail ||
    previousTail === nextTail ||
    previousTail.id !== nextTail.id ||
    previousTail.role !== "agent" ||
    nextTail.role !== "agent" ||
    previousTail.agent !== nextTail.agent ||
    previousCoalescedTail.role !== "agent" ||
    previousCoalescedTail.agent !== nextTail.agent ||
    messageMayContainProposedPlan(nextTail) ||
    !coalescedMessageContainsSource(previousCoalescedTail, previousTail.id) ||
    previousCoalescedTail.parts.length < previousTail.parts.length
  ) {
    return null;
  }

  const stablePrefixPartCount =
    previousCoalescedTail.parts.length - previousTail.parts.length;
  const nextCoalescedTail: AgentUIMessage = {
    ...previousCoalescedTail,
    parts: [
      ...previousCoalescedTail.parts.slice(0, stablePrefixPartCount),
      ...nextTail.parts,
    ],
    sourceMessageIds:
      previousCoalescedTail.sourceMessageIds ??
      input.runtimeMessages
        .filter((message) => message.role === "agent")
        .map((message) => message.id),
    meta: nextTail.meta ?? previousCoalescedTail.meta,
  };

  const messages = previousModel.messages.slice(0, -1);
  messages.push(nextCoalescedTail);
  return {
    messages,
    ...deriveSteadyTailTranscriptFacts({
      previousModel,
      previousTail,
      nextTail: nextCoalescedTail,
      tailIndex: messages.length - 1,
      messages,
    }),
    planOccurrencesRaw: previousModel.planOccurrencesRaw,
  };
}

function coalescedMessageContainsSource(
  message: AgentUIMessage,
  sourceId: string,
): boolean {
  return (message.sourceMessageIds ?? [message.id]).includes(sourceId);
}

function appendRuntimeMessageToTranscript(
  messages: UIMessage[],
  message: UIMessage,
): number {
  const previous = messages.at(-1);
  if (
    previous?.role === "agent" &&
    message.role === "agent" &&
    canCoalesceAgentMessages(previous, message)
  ) {
    const index = messages.length - 1;
    messages[index] = coalesceAgentMessages(previous, message);
    return index;
  }

  messages.push(message);
  return messages.length - 1;
}

function deriveSteadyTailTranscriptFacts({
  previousModel,
  previousTail,
  nextTail,
  tailIndex,
  messages,
}: {
  previousModel: TranscriptDisplayModel;
  previousTail: UIMessage;
  nextTail: UIMessage;
  tailIndex: number;
  messages: UIMessage[];
}): Pick<
  TranscriptDisplayModel,
  "latestAgentMessageIndex" | "hasRenderableAgentParts" | "hasPendingToolCall"
> {
  const previousTailRenderable = messageHasRenderableAgentParts(previousTail);
  const nextTailRenderable = messageHasRenderableAgentParts(nextTail);
  const previousTailPendingTool = messageHasPendingToolCall(previousTail);
  const nextTailPendingTool = messageHasPendingToolCall(nextTail);

  if (
    previousTailRenderable !== nextTailRenderable ||
    (previousTailPendingTool && !nextTailPendingTool)
  ) {
    return deriveTranscriptFacts(messages);
  }

  return {
    latestAgentMessageIndex:
      nextTail.role === "agent"
        ? tailIndex
        : previousModel.latestAgentMessageIndex,
    hasRenderableAgentParts:
      previousModel.hasRenderableAgentParts || nextTailRenderable,
    hasPendingToolCall: previousModel.hasPendingToolCall || nextTailPendingTool,
  };
}
