import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import { emitLinearActivitiesForCanonicalBatch } from "@/server-lib/linear-agent-activity";
import { emitSlackActivitiesForCanonicalBatch } from "@/server-lib/slack/slack-agent-activity";

type ThreadIntegrationSource = {
  sourceType: string | null;
  sourceMetadata: unknown;
} | null;

export function emitThreadIntegrationActivitiesForCanonicalBatch({
  thread,
  threadId,
  threadChatId,
  canonicalEvents,
  daemonRunStatus,
  isRecoveryFire,
  customErrorMessage,
  costUsd,
}: {
  thread: ThreadIntegrationSource;
  threadId: string;
  threadChatId: string;
  canonicalEvents: readonly CanonicalEvent[] | null | undefined;
  daemonRunStatus: string;
  isRecoveryFire: boolean;
  customErrorMessage?: string | null;
  costUsd: number;
}): Array<Promise<void>> {
  if (!canonicalEvents || canonicalEvents.length === 0) {
    return [];
  }

  const isDone = daemonRunStatus === "completed" && !isRecoveryFire;
  const isError = daemonRunStatus === "failed" && !isRecoveryFire;
  const emissions: Array<Promise<void>> = [];

  if (
    thread?.sourceType === "linear-mention" &&
    thread.sourceMetadata != null
  ) {
    const linearMeta = thread.sourceMetadata as Extract<
      ThreadSourceMetadata,
      { type: "linear-mention" }
    >;
    if (linearMeta.agentSessionId) {
      emissions.push(
        emitLinearActivitiesForCanonicalBatch(linearMeta, canonicalEvents, {
          isDone,
          isError,
          customErrorMessage,
          costUsd,
        }),
      );
    }
  }

  if (thread?.sourceType === "slack-mention") {
    emissions.push(
      emitSlackActivitiesForCanonicalBatch({
        threadId,
        threadChatId,
        canonicalEvents,
        isDone,
        isError,
        isRecoveryFire,
        customErrorMessage,
      }),
    );
  }

  return emissions;
}
