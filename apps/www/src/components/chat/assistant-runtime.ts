"use client";

import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type {
  UIMessage,
  UIUserMessage,
  UIAgentMessage,
  UISystemMessage,
  UIPart,
  ThreadStatus,
} from "@terragon/shared";
import type { AllToolParts } from "@terragon/shared";
import { isAgentWorking } from "@/agent/thread-status";

// ---------------------------------------------------------------------------
// Part conversion: UIPart → assistant-ui content part
// ---------------------------------------------------------------------------

// ThreadMessageLike.content accepts these part types — we extract the union
// from the library type to avoid maintaining our own copy.
type ContentPart = Exclude<
  Extract<ThreadMessageLike["content"], readonly unknown[]>[number],
  never
>;

function convertPart(part: UIPart): ContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };

    case "thinking":
      return { type: "reasoning", text: part.thinking };

    case "tool": {
      const toolPart = part as AllToolParts;
      const result =
        toolPart.status === "completed" || toolPart.status === "error"
          ? toolPart.result
          : undefined;
      return {
        type: "tool-call",
        toolCallId: toolPart.id,
        toolName: toolPart.name,
        args: (toolPart.parameters ?? {}) as Record<string, never>,
        result,
        isError: toolPart.status === "error",
      };
    }

    case "image":
      return { type: "image", image: part.image_url };

    case "rich-text":
      return { type: "data-rich-text" as const, data: part } as ContentPart;

    case "pdf":
      return { type: "data-pdf" as const, data: part } as ContentPart;

    case "text-file":
      return { type: "data-text-file" as const, data: part } as ContentPart;

    case "plan":
      return { type: "data-plan" as const, data: part } as ContentPart;

    default:
      return { type: "data-unknown" as const, data: part } as ContentPart;
  }
}

// ---------------------------------------------------------------------------
// Message conversion: UIMessage → ThreadMessageLike
// ---------------------------------------------------------------------------

function convertMessage(
  msg: UIMessage,
  isLatest: boolean,
  threadIsWorking: boolean,
): ThreadMessageLike {
  switch (msg.role) {
    case "user": {
      const userMsg = msg as UIUserMessage;
      return {
        id: userMsg.id,
        role: "user" as const,
        content: userMsg.parts.map(convertPart),
        createdAt: userMsg.timestamp ? new Date(userMsg.timestamp) : undefined,
      };
    }

    case "agent": {
      const agentMsg = msg as UIAgentMessage;
      const hasPendingTool = agentMsg.parts.some(
        (p) => p.type === "tool" && (p as AllToolParts).status === "pending",
      );

      let status: ThreadMessageLike["status"];
      if (isLatest && threadIsWorking) {
        status = { type: "running" };
      } else if (hasPendingTool) {
        status = { type: "requires-action", reason: "tool-calls" };
      } else {
        status = { type: "complete", reason: "stop" };
      }

      return {
        id: agentMsg.id,
        role: "assistant" as const,
        content: agentMsg.parts.map(convertPart),
        status,
      };
    }

    case "system": {
      const sysMsg = msg as UISystemMessage;
      // assistant-ui requires system messages to have exactly one text part
      return {
        id: sysMsg.id,
        role: "system" as const,
        content: `[${sysMsg.message_type}]`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime hook
// ---------------------------------------------------------------------------

export function useTerragonRuntime({
  messages,
  threadStatus,
  onNew,
  onCancel,
}: {
  messages: UIMessage[];
  threadStatus: ThreadStatus | null;
  onNew: (text: string) => Promise<void>;
  onCancel?: () => Promise<void>;
}) {
  const isRunning = threadStatus !== null && isAgentWorking(threadStatus);

  return useExternalStoreRuntime({
    messages,
    convertMessage: (msg: UIMessage, idx: number) =>
      convertMessage(msg, idx === messages.length - 1, isRunning),
    isRunning,
    onNew: async (message) => {
      const text = message.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");
      await onNew(text);
    },
    onCancel: onCancel
      ? async () => {
          await onCancel();
        }
      : undefined,
  });
}
