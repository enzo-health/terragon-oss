import type { ThreadUserMessagePart } from "@assistant-ui/react";
import type { SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import { type EncodedRunMetadata, encodeRunMetadata } from "@/lib/run-metadata";
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
  clientSubmissionId: string;
}) => Promise<void>;

export type ComposerOptimisticSubmit = (args: {
  userMessage: DBUserMessage;
  clientSubmissionId: string;
}) => void;

export type RouteComposerSubmitArgs = {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
  clientSubmissionId: string;
  threadRuntime: ComposerSubmitRuntime | null;
  isAgentWorking: boolean;
  isQueueingEnabled: boolean;
  submitFallback: ComposerSubmitCommand;
  queueMessage?: ComposerSubmitCommand;
  optimisticSubmit?: ComposerOptimisticSubmit;
};

export async function routeComposerSubmit({
  userMessage,
  selectedModels,
  repoFullName,
  branchName,
  saveAsDraft,
  scheduleAt,
  clientSubmissionId,
  threadRuntime,
  isAgentWorking,
  isQueueingEnabled,
  submitFallback,
  queueMessage,
  optimisticSubmit,
}: RouteComposerSubmitArgs): Promise<ComposerSubmitRouteOutcome> {
  const commandArgs = {
    userMessage,
    selectedModels,
    repoFullName,
    branchName,
    saveAsDraft,
    scheduleAt,
    clientSubmissionId,
  };

  // A queued message is not a started run, so it must NOT flip lifecycle to
  // booting. Compute the queue route up front and skip the optimistic flip for
  // it. The branch order below is unchanged (draft/schedule still beats queue);
  // only the optimistic flip is guarded. isQueueRoute excludes
  // saveAsDraft/scheduleAt because a draft/scheduled submit takes the fallback
  // branch, so the flip still fires for that path — matching legacy handleSubmit.
  const isQueueRoute =
    threadRuntime !== null &&
    !saveAsDraft &&
    scheduleAt === null &&
    isAgentWorking &&
    isQueueingEnabled &&
    queueMessage !== undefined;

  if (!isQueueRoute) {
    optimisticSubmit?.({ userMessage, clientSubmissionId });
  }

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
          clientSubmissionId,
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
