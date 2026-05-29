import type { DBMessage, DBUserMessage } from "@terragon/shared";
import type { RouterDependencies, ThreadChatUpdateAccumulator } from "../types";

export async function tryAutoCompactRecovery(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
  threadChatId: string;
  threadChatUpdates: ThreadChatUpdateAccumulator;
  isPromptTooLong: boolean;
  allowTerminalRecoverySideEffects: boolean;
}): Promise<{
  recovered: boolean;
  isError: boolean;
  isPromptTooLong: boolean;
  isDone: boolean;
  threadChatUpdates: ThreadChatUpdateAccumulator;
}> {
  const {
    deps,
    userId,
    threadId,
    threadChatId,
    threadChatUpdates,
    isPromptTooLong,
    allowTerminalRecoverySideEffects,
  } = params;

  if (!isPromptTooLong || !allowTerminalRecoverySideEffects) {
    return {
      recovered: false,
      isError: true,
      isPromptTooLong,
      isDone: false,
      threadChatUpdates,
    };
  }

  try {
    const db = (await import("@/lib/db")).db;
    const shouldAutoCompact = await deps.getFeatureFlagForUser({
      db,
      userId,
      flagName: "autoCompactOnContextError",
    });

    if (!shouldAutoCompact) {
      return {
        recovered: false,
        isError: true,
        isPromptTooLong,
        isDone: false,
        threadChatUpdates,
      };
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("Auto-compacting due to prompt-too-long error", {
        threadId,
        threadChatId,
      });
    }

    const compactResult = await deps.compactThreadChat({
      userId,
      threadId,
      threadChatId,
    });

    if (compactResult && compactResult.summary) {
      if (process.env.NODE_ENV !== "production") {
        console.log(`Successfully compacted after prompt-too-long error`, {
          threadId,
          threadChatId,
        });
      }
      const compactMessage: DBMessage = {
        type: "system",
        message_type: "compact-result",
        parts: [
          {
            type: "text",
            text: `Thread was automatically compacted due to context length limit. Summary:\n\n${compactResult.summary}`,
          },
        ],
        timestamp: new Date().toISOString(),
      };

      const continueMessage: DBUserMessage = {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Continue" }],
        timestamp: new Date().toISOString(),
      };

      const updatedAppendMessages = [
        ...(threadChatUpdates.appendMessages ?? []),
        compactMessage,
      ];

      return {
        recovered: true,
        isError: false,
        isPromptTooLong: false,
        isDone: true,
        threadChatUpdates: {
          ...threadChatUpdates,
          appendMessages: updatedAppendMessages,
          appendQueuedMessages: [continueMessage],
          errorMessage: null,
          errorMessageInfo: null,
          contextLength: null,
          sessionId: null,
        },
      };
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(`Failed to compact after prompt-too-long error`, {
        threadId,
        threadChatId,
      });
    }

    return {
      recovered: false,
      isError: true,
      isPromptTooLong,
      isDone: false,
      threadChatUpdates,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[daemon-event] auto-compact recovery failed; continuing without recovery",
        { threadId, threadChatId, err },
      );
    }
    return {
      recovered: false,
      isError: true,
      isPromptTooLong,
      isDone: false,
      threadChatUpdates,
    };
  }
}
