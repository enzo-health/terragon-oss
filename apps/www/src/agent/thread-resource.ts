import { ThreadErrorType, ThreadChat } from "@terragon/shared";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { ThreadError } from "./error";
import { getSandboxForThreadOrNull, maybeHibernateSandbox } from "./sandbox";
import { ISandboxSession } from "@terragon/sandbox/types";
import { withSandboxResource } from "./sandbox-resource";
import { updateThreadChatWithTransition } from "./update-status";
import { db } from "@/lib/db";
import { waitUntil } from "@vercel/functions";
import { extendSandboxLife } from "@terragon/sandbox";
import { trackUsageEvents } from "@/server-lib/usage-events";
import { emitThreadIntegrationErrorActivities } from "@/server-lib/thread-integration-activity";

export async function withThreadChat<T>({
  userId,
  threadId,
  threadChatId,
  execOrThrow,
  onExit,
  onError,
}: {
  threadId: string;
  threadChatId: string | null;
  userId: string;
  execOrThrow: (threadChat: ThreadChat | null) => Promise<T>;
  onExit?: (threadChat: ThreadChat | null) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}): Promise<T | undefined> {
  let threadChat: ThreadChat | null | undefined = null;
  let result: T | undefined;
  try {
    threadChat = threadChatId
      ? await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId,
        })
      : null;
    if (threadChatId && !threadChat) {
      throw new ThreadError("unknown-error", "Thread chat not found", null);
    }
    result = await execOrThrow(threadChat ?? null);
  } catch (error) {
    let errorType: ThreadErrorType;
    let errorInfo: string;
    if (error instanceof ThreadError) {
      errorType = error.type;
      errorInfo = error.info;
    } else {
      errorType = "unknown-error";
      errorInfo = error instanceof Error ? error.message : "Unknown error";
    }
    console.error("Thread error", error);
    if (threadChatId) {
      const errorMessage = {
        type: "error" as const,
        error_type: errorType,
        error_info: errorInfo,
        timestamp: new Date().toISOString(),
      };
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.error",
        chatUpdates: {
          errorMessage: errorType,
          errorMessageInfo: errorInfo,
          appendMessages: [errorMessage],
        },
        markAsUnread: true,
      });
      try {
        const thread = await getThreadMinimal({ db, threadId, userId });
        for (const emission of emitThreadIntegrationErrorActivities({
          thread,
          threadId,
          threadChatId,
          errorType,
          errorInfo,
        })) {
          waitUntil(
            emission.catch((integrationError) => {
              console.error(
                "Failed to emit thread integration error",
                integrationError,
              );
            }),
          );
        }
      } catch (slackError) {
        console.error(
          "Failed to schedule thread integration error",
          slackError,
        );
      }
      await onError?.(error instanceof Error ? error : new Error(errorInfo));
    }
  } finally {
    try {
      await onExit?.(threadChat ?? null);
    } catch (error) {
      console.error("Error in onExit:", error);
    }
  }
  return result;
}

export async function withThreadSandboxSession<T>({
  threadId,
  threadChatId,
  userId,
  label,
  onBeforeExec,
  execOrThrow,
  onExit,
  onError,
  fastResume = true,
}: {
  threadId: string;
  threadChatId: string | null;
  userId: string;
  label: string;
  onBeforeExec?: ({
    threadChat,
  }: {
    threadChat: ThreadChat | null;
  }) => Promise<boolean>;
  execOrThrow: ({
    threadChat,
    session,
  }: {
    threadChat: ThreadChat | null;
    session: ISandboxSession | null;
  }) => Promise<T>;
  onExit?: ({
    threadChat,
  }: {
    threadChat: ThreadChat | null;
  }) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  fastResume?: boolean;
}): Promise<T | undefined> {
  let sandboxSessionOrNull: ISandboxSession | null = null;
  let sandboxUsageStartTime: number | null = null;
  return withThreadChat({
    threadId,
    userId,
    threadChatId,
    execOrThrow: async (threadChat) => {
      if (typeof onBeforeExec === "function") {
        const shouldContinue = await onBeforeExec({ threadChat });
        if (!shouldContinue) {
          return undefined;
        }
      }

      const thread = await getThreadMinimal({ db, threadId, userId });
      if (!thread?.codesandboxId) {
        return await execOrThrow({ threadChat, session: null });
      }
      return await withSandboxResource({
        label,
        sandboxId: thread.codesandboxId,
        callback: async () => {
          sandboxSessionOrNull = await getSandboxForThreadOrNull({
            db,
            threadId,
            threadChatIdOrNull: threadChatId ?? null,
            userId,
            fastResume,
            onStatusUpdate: async () => {}, // No-op callback as thread-resource doesn't track status
          });
          if (sandboxSessionOrNull) {
            sandboxUsageStartTime = Date.now();
            await extendSandboxLife({
              sandboxProvider: sandboxSessionOrNull.sandboxProvider,
              sandboxId: sandboxSessionOrNull.sandboxId,
            });
          }
          return await execOrThrow({
            threadChat,
            session: sandboxSessionOrNull,
          });
        },
      });
    },
    onExit: async (threadChat) => {
      try {
        await onExit?.({ threadChat: threadChat ?? null });
      } finally {
        if (sandboxSessionOrNull) {
          try {
            // Log sandbox usage duration
            if (sandboxUsageStartTime) {
              const usageDuration = Date.now() - sandboxUsageStartTime;
              waitUntil(
                trackUsageEvents({
                  userId,
                  applicationDurationMs: usageDuration,
                }),
              );
            }
            waitUntil(
              maybeHibernateSandbox({
                threadId,
                userId,
                session: sandboxSessionOrNull,
              }),
            );
          } catch (e) {
            console.error("Failed to hibernate sandbox:", e);
          }
        }
      }
    },
    onError,
  });
}
