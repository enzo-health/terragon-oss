"use client";

import React from "react";
import type { DBMessage, DBUserMessage } from "@terragon/shared";
import { ThreadInfoFull } from "@terragon/shared";
import { X } from "lucide-react";
import { toast } from "sonner";
import { GenericPromptBox } from "@/components/promptbox/generic-promptbox";
import { Button } from "@/components/ui/button";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { cn } from "@/lib/utils";
import { followUp } from "@/server-actions/follow-up";
import { useOptimisticUpdateThreadChat } from "./hooks";

/**
 * Comment widget component
 */
interface CommentWidgetProps {
  side: 1 | 2; // SplitSide enum: 1 = old, 2 = new
  lineNumber: number;
  onClose: () => void;
  fileName: string;
  thread: ThreadInfoFull;
  threadChatId?: string;
  threadMessages?: DBMessage[];
  isAddition: boolean;
}

export function CommentWidget({
  side,
  lineNumber,
  onClose,
  fileName,
  thread,
  threadChatId,
  threadMessages,
  isAddition,
}: CommentWidgetProps) {
  const updateThreadChat = useOptimisticUpdateThreadChat({
    threadId: thread.id,
    threadChatId,
  });
  const emptyMessage: DBUserMessage = {
    type: "user",
    parts: [{ type: "text", text: "" }],
    model: null,
  };
  const handleSubmit = async ({
    userMessage,
  }: {
    userMessage: DBUserMessage;
  }) => {
    if (!threadChatId || !threadMessages) return;
    const plainText = convertToPlainText({ message: userMessage });
    if (plainText.length === 0) return;

    const sideLabel = isAddition ? "new" : "old";
    const contextPrefix = `[Comment on ${fileName} line ${lineNumber} (${sideLabel})]\n\n`;
    const contextualMessage: DBUserMessage = {
      ...userMessage,
      parts: [{ type: "text", text: contextPrefix }, ...userMessage.parts],
    };

    // Snapshot pre-update state so we can revert on failure.
    const prevMessages = threadMessages;

    // Optimistic update
    updateThreadChat({
      messages: [...threadMessages, contextualMessage],
      errorMessage: null,
      errorMessageInfo: null,
      status: "booting",
    });

    onClose();

    const result = await followUp({
      threadId: thread.id,
      threadChatId,
      message: contextualMessage,
    });

    if (!result.success) {
      // Revert the optimistic message and surface the error to the user.
      updateThreadChat({
        messages: prevMessages,
        errorMessage: result.errorMessage,
        errorMessageInfo: null,
        status: "complete",
      });
      toast.error("Failed to post comment", {
        description:
          typeof result.errorMessage === "string"
            ? result.errorMessage
            : "An unknown error occurred. Please try again.",
      });
    }
  };
  return (
    <div
      className={cn(
        "p-4 font-sans",
        isAddition
          ? "bg-green-50 dark:bg-green-950/20"
          : "bg-red-50 dark:bg-red-950/20",
      )}
    >
      <div className="bg-background border rounded-lg shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground">
            Add a comment on this line
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-6 w-6 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <GenericPromptBox
          message={emptyMessage}
          repoFullName={thread.githubRepoFullName}
          branchName={thread.branchName ?? thread.repoBaseBranchName}
          forcedAgent={null}
          forcedAgentVersion={null}
          onSubmit={handleSubmit}
          placeholder="Leave a comment..."
          autoFocus={true}
          hideSubmitButton={false}
          clearContentOnSubmit={true}
          hideModelSelector={true}
          hideModeSelector={true}
          hideAddContextButton={true}
          hideFileAttachmentButton={true}
          hideVoiceInput={false}
        />
      </div>
    </div>
  );
}
