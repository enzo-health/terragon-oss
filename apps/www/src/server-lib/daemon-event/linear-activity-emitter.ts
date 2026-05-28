import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import type { ClaudeMessage } from "@terragon/daemon/shared";
import type { RouterDependencies, ThreadChatUpdateAccumulator } from "./types";
import type { MessageClassification } from "./types";

export async function maybeEmitLinearActivities(params: {
  deps: RouterDependencies;
  threadId: string;
  sourceType: string | null;
  sourceMetadata: ThreadSourceMetadata | null;
  messages: ClaudeMessage[];
  classification: MessageClassification;
  threadChatUpdates: ThreadChatUpdateAccumulator;
  suppressTerminalRecoverySideEffects: boolean;
}): Promise<void> {
  const {
    deps,
    threadId,
    sourceType,
    sourceMetadata,
    messages,
    classification,
    threadChatUpdates,
    suppressTerminalRecoverySideEffects,
  } = params;

  if (
    suppressTerminalRecoverySideEffects ||
    sourceType !== "linear-mention" ||
    sourceMetadata == null
  ) {
    return;
  }

  const linearMeta = sourceMetadata as Extract<
    ThreadSourceMetadata,
    { type: "linear-mention" }
  >;

  if (!linearMeta.agentSessionId) {
    console.warn(
      "[handle-daemon-event] Skipping Linear activity: legacy fn-1 thread missing agentSessionId",
      { threadId },
    );
    return;
  }

  const hasQueuedFollowUp =
    (threadChatUpdates.appendQueuedMessages?.length ?? 0) > 0;
  const effectivelyDone =
    classification.isDone && !classification.isError && !hasQueuedFollowUp;
  const effectivelyError = classification.isError && !hasQueuedFollowUp;

  const { waitUntil } = await import("@vercel/functions");
  waitUntil(
    deps.emitLinearActivitiesForDaemonEvent(linearMeta, messages, {
      isDone: effectivelyDone,
      isError: effectivelyError,
      customErrorMessage: classification.customErrorMessage,
      costUsd: classification.costUsd,
    }),
  );
}
