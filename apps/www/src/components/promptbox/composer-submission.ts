import type { SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import type { ThreadUserMessagePart } from "@assistant-ui/react";
import { encodeTerragonAgUiRunConfig } from "@/lib/terragon-ag-ui-run-config";
import type { TSubmitForm } from "./send-button";

export type ComposerSubmissionOutcome =
  | { type: "runtime-append-started" }
  | { type: "queued-locally" }
  | { type: "fallback-submitted"; reason: "no-runtime" | "unsupported-parts" }
  | { type: "validation-no-op"; reason: "empty-runtime-content" };

export type ComposerSubmissionRuntime = {
  append: (message: {
    role: "user";
    content: ThreadUserMessagePart[];
    runConfig: { custom: ReturnType<typeof encodeTerragonAgUiRunConfig> };
  }) => Promise<void> | void;
};

export type ComposerSubmissionCommand = (args: {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
}) => Promise<void>;

export type SubmitComposerMessageArgs = {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
  threadRuntime: ComposerSubmissionRuntime | null;
  isAgentWorking: boolean;
  isQueueingEnabled: boolean;
  submitFallback: ComposerSubmissionCommand;
  queueMessage?: ComposerSubmissionCommand;
};

export async function submitComposerMessage({
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
}: SubmitComposerMessageArgs): Promise<ComposerSubmissionOutcome> {
  const commandArgs = {
    userMessage,
    selectedModels,
    repoFullName,
    branchName,
    saveAsDraft,
    scheduleAt,
  };

  if (
    threadRuntime !== null &&
    isAgentWorking &&
    isQueueingEnabled &&
    queueMessage !== undefined
  ) {
    await queueMessage(commandArgs);
    return { type: "queued-locally" };
  }

  const routing = getComposerRuntimeRouting(userMessage);
  if (threadRuntime !== null && routing.type === "runtime") {
    await threadRuntime.append({
      role: "user",
      content: routing.content,
      runConfig: {
        custom: encodeTerragonAgUiRunConfig({
          selectedModel: userMessage.model,
          permissionMode: userMessage.permissionMode,
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

type ComposerRuntimeRouting =
  | { type: "runtime"; content: ThreadUserMessagePart[] }
  | { type: "unsupported-parts" }
  | { type: "empty-runtime-content" };

export function getComposerRuntimeRouting(
  userMessage: DBUserMessage,
): ComposerRuntimeRouting {
  if (hasUnsupportedRuntimeParts(userMessage)) {
    return { type: "unsupported-parts" };
  }

  const content = dbPartsToAssistantUiContent(userMessage.parts);
  return content.length > 0
    ? { type: "runtime", content }
    : { type: "empty-runtime-content" };
}

function hasUnsupportedRuntimeParts(userMessage: DBUserMessage): boolean {
  return userMessage.parts.some(
    (part) => part.type === "pdf" || part.type === "text-file",
  );
}

export function dbPartsToAssistantUiContent(
  parts: DBUserMessage["parts"],
): ThreadUserMessagePart[] {
  const result: ThreadUserMessagePart[] = [];
  for (const part of parts) {
    if (part.type === "rich-text") {
      const text = part.nodes
        .map((node) => {
          if (typeof node === "string") return node;
          if ("text" in node && typeof node.text === "string") return node.text;
          return "";
        })
        .join("");
      if (text.length > 0) {
        result.push({ type: "text", text });
      }
    } else if (part.type === "image") {
      result.push({ type: "image", image: part.image_url });
    }
  }
  return result;
}
