"use client";

import { memo } from "react";
import { useTerragonThread } from "./thread-context";
import { ChatMessage } from "../chat-message";
import { MessageToolbar } from "../chat-message-toolbar";
import type { UIMessage } from "@terragon/shared";

/**
 * Renders a user message within the assistant-ui thread.
 *
 * `isLatestMessage` / `isFirstUserMessage` are passed explicitly by the
 * parent `TerragonThread.messages.map()` loop — we deliberately do NOT
 * derive them from `ctx.messages.length`, because reading the full
 * messages array from context would resubscribe every user-message row
 * to a value that churns on every token delta.
 */
export const TerragonUserMessage = memo(function TerragonUserMessage({
  message,
  messageIndex,
  isLatestMessage,
  isFirstUserMessage,
}: {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
  isFirstUserMessage: boolean;
}) {
  const ctx = useTerragonThread();

  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        isLatestMessage={isLatestMessage}
        isAgentWorking={false}
        messagePartProps={ctx.messagePartProps}
        artifactDescriptors={ctx.artifactDescriptors}
        onOpenArtifact={ctx.onOpenArtifact}
        planOccurrences={ctx.planOccurrences}
      />
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={false}
        isAgentWorking={ctx.isAgentWorking}
        redoDialogData={isFirstUserMessage ? ctx.redoDialogData : undefined}
      />
    </div>
  );
});
