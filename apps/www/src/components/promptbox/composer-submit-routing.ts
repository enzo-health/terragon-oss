import type { SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import type { TSubmitForm } from "./send-button";

export type ComposerSubmitRouteOutcome =
  | { type: "queued-locally" }
  | { type: "fallback-submitted"; reason: "draft-or-schedule" | "default" };

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
  // it. A draft/scheduled submit takes the fallback branch, so the flip still
  // fires for that path — matching legacy handleSubmit.
  const isQueueRoute =
    !saveAsDraft &&
    scheduleAt === null &&
    isAgentWorking &&
    isQueueingEnabled &&
    queueMessage !== undefined;

  if (!isQueueRoute) {
    optimisticSubmit?.({ userMessage, clientSubmissionId });
  }

  if (saveAsDraft || scheduleAt !== null) {
    await submitFallback(commandArgs);
    return { type: "fallback-submitted", reason: "draft-or-schedule" };
  }

  if (isQueueRoute && queueMessage !== undefined) {
    await queueMessage(commandArgs);
    return { type: "queued-locally" };
  }

  await submitFallback(commandArgs);
  return { type: "fallback-submitted", reason: "default" };
}
