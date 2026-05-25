import type { SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import type { ThreadUserMessagePart } from "@assistant-ui/react";
import { encodeRunMetadata, type EncodedRunMetadata } from "@/lib/run-metadata";
import {
  dbUserMessageHasUnsupportedAssistantContent,
  dbUserPartsToAssistantContent,
} from "@/lib/user-message-content";
import type { TSubmitForm } from "./send-button";

export type ComposerSubmitRouteOutcome =
  | { type: "runtime-append-started" }
  | { type: "queued-locally" }
  | {
      type: "fallback-submitted";
      reason: "no-runtime" | "unsupported-parts" | "unsupported-intent";
    }
  | { type: "validation-no-op"; reason: "empty-runtime-content" };

export type ComposerSubmitRuntime = {
  append: (message: {
    role: "user";
    content: ThreadUserMessagePart[];
    runConfig: { custom: EncodedRunMetadata };
  }) => Promise<void> | void;
};

export type ComposerSubmitCommand = (args: {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
}) => Promise<void>;

export type RouteComposerSubmitArgs = {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
  threadRuntime: ComposerSubmitRuntime | null;
  isAgentWorking: boolean;
  isQueueingEnabled: boolean;
  submitFallback: ComposerSubmitCommand;
  queueMessage?: ComposerSubmitCommand;
};

export async function routeComposerSubmit({
  userMessage,
  selectedModels,
  repoFullName,
  branchName,
  saveAsDraft,
  scheduleAt,
  threadRuntime,
  isAgentWorking,
  isQueueingEnabled,
  submitFallback,
  queueMessage,
}: RouteComposerSubmitArgs): Promise<ComposerSubmitRouteOutcome> {
  const commandArgs = {
    userMessage,
    selectedModels,
    repoFullName,
    branchName,
    saveAsDraft,
    scheduleAt,
  };

  if (threadRuntime !== null && (saveAsDraft || scheduleAt !== null)) {
    await submitFallback(commandArgs);
    return { type: "fallback-submitted", reason: "unsupported-intent" };
  }

  if (
    threadRuntime !== null &&
    isAgentWorking &&
    isQueueingEnabled &&
    queueMessage !== undefined
  ) {
    await queueMessage(commandArgs);
    return { type: "queued-locally" };
  }

  const routing = classifyComposerSubmitRoute(userMessage);
  if (threadRuntime !== null && routing.type === "runtime") {
    await threadRuntime.append({
      role: "user",
      content: routing.content,
      runConfig: {
        custom: encodeRunMetadata({
          selectedModel: userMessage.model,
          permissionMode: userMessage.permissionMode,
          clientSubmissionId: crypto.randomUUID(),
        }),
      },
    });
    return { type: "runtime-append-started" };
  }

  if (threadRuntime !== null && routing.type === "unsupported-parts") {
    await submitFallback(commandArgs);
    return { type: "fallback-submitted", reason: "unsupported-parts" };
  }

  if (threadRuntime !== null) {
    return { type: "validation-no-op", reason: "empty-runtime-content" };
  }

  await submitFallback(commandArgs);
  return { type: "fallback-submitted", reason: "no-runtime" };
}

type ComposerSubmitRoute =
  | { type: "runtime"; content: ThreadUserMessagePart[] }
  | { type: "unsupported-parts" }
  | { type: "empty-runtime-content" };

export function classifyComposerSubmitRoute(
  userMessage: DBUserMessage,
): ComposerSubmitRoute {
  if (dbUserMessageHasUnsupportedAssistantContent(userMessage)) {
    return { type: "unsupported-parts" };
  }

  const content = dbUserPartsToAssistantContent(userMessage.parts);
  return content.length > 0
    ? { type: "runtime", content }
    : { type: "empty-runtime-content" };
}
