import type { DBSystemMessage, DBUserMessage } from "@terragon/shared";
import type { RouterDependencies, ThreadChatUpdateAccumulator } from "../types";

export async function tryOAuthRetryRecovery(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
  threadChatId: string;
  threadChatUpdates: ThreadChatUpdateAccumulator;
  isOAuthTokenRevoked: boolean;
  allowTerminalRecoverySideEffects: boolean;
}): Promise<{
  recovered: boolean;
  invalidTokenRetryQueued: boolean;
  isError: boolean;
  isOAuthTokenRevoked: boolean;
  isDone: boolean;
  threadChatUpdates: ThreadChatUpdateAccumulator;
}> {
  const {
    deps,
    threadId,
    threadChatId,
    threadChatUpdates,
    isOAuthTokenRevoked,
    allowTerminalRecoverySideEffects,
  } = params;

  if (!isOAuthTokenRevoked || !allowTerminalRecoverySideEffects) {
    return {
      recovered: false,
      invalidTokenRetryQueued: false,
      isError: true,
      isOAuthTokenRevoked,
      isDone: false,
      threadChatUpdates,
    };
  }

  try {
    if (process.env.NODE_ENV !== "production") {
      console.log(`OAuth token revoked error detected, checking for retry`, {
        threadId,
        threadChatId,
      });
    }

    const db = (await import("@/lib/db")).db;
    const shouldRetry = !(await deps.hasInvalidTokenRetrySideEffectMarker({
      db,
      threadChatId,
    }));

    if (!shouldRetry) {
      if (process.env.NODE_ENV !== "production") {
        console.log(
          "Skipping retry because invalid-token-retry marker already exists",
          {
            threadId,
            threadChatId,
          },
        );
      }
      return {
        recovered: false,
        invalidTokenRetryQueued: false,
        isError: true,
        isOAuthTokenRevoked,
        isDone: false,
        threadChatUpdates,
      };
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("Adding invalid-token-retry and queueing retry");
    }

    const invalidTokenRetryMessage: DBSystemMessage = {
      type: "system",
      message_type: "invalid-token-retry",
      parts: [],
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
      invalidTokenRetryMessage,
    ];

    return {
      recovered: true,
      invalidTokenRetryQueued: true,
      isError: false,
      isOAuthTokenRevoked: false,
      isDone: true,
      threadChatUpdates: {
        ...threadChatUpdates,
        appendMessages: updatedAppendMessages,
        appendQueuedMessages: [continueMessage],
        errorMessage: null,
        errorMessageInfo: null,
      },
    };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[daemon-event] OAuth retry recovery failed; continuing without recovery",
        { threadId, threadChatId, err },
      );
    }
    return {
      recovered: false,
      invalidTokenRetryQueued: false,
      isError: true,
      isOAuthTokenRevoked,
      isDone: false,
      threadChatUpdates,
    };
  }
}
