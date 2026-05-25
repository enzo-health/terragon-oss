import type { SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import type { ThreadUserMessagePart } from "@assistant-ui/react";
import { encodeRunMetadata } from "@/lib/run-metadata";
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
    runConfig: { custom: ReturnType<typeof encodeRunMetadata> };
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
    void Promise.resolve(
      threadRuntime.append({
        role: "user",
        content: routing.content,
        runConfig: {
          custom: encodeRunMetadata({
            selectedModel: userMessage.model,
            permissionMode: userMessage.permissionMode,
            clientSubmissionId: crypto.randomUUID(),
          }),
        },
      }),
    ).catch((error) => {
      console.error("[composer-submit-routing] runtime append failed", error);
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
  if (hasUnsupportedRuntimeParts(userMessage)) {
    return { type: "unsupported-parts" };
  }

  const content = toAssistantUserContent(userMessage.parts);
  return content.length > 0
    ? { type: "runtime", content }
    : { type: "empty-runtime-content" };
}

function hasUnsupportedRuntimeParts(userMessage: DBUserMessage): boolean {
  return userMessage.parts.some(
    (part) => part.type === "pdf" || part.type === "text-file",
  );
}

export function toAssistantUserContent(
  parts: DBUserMessage["parts"],
): ThreadUserMessagePart[] {
  const result: ThreadUserMessagePart[] = [];
  for (const part of parts) {
    if (part.type === "rich-text") {
      const text = part.nodes
        .map((node) => {
          if (typeof node === "string") return node;
          if (node.type === "mention") return `@${node.text}`;
          if ("text" in node && typeof node.text === "string") return node.text;
          return "";
        })
        .join("");
      if (text.length > 0) {
        result.push({ type: "text", text });
      }
    } else if (part.type === "text" && part.text.length > 0) {
      result.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      result.push({ type: "image", image: part.image_url });
    }
  }
  return result;
}
