import { getStalledThreadChats } from "@terragon/shared/model/threads";
import { DB } from "@terragon/shared/db";
import {
  updateThreadChatWithTransition,
  type UpdateThreadChatWithTransitionResult,
} from "@/agent/update-status";

export const RUN_DEADLINE_CUTOFF_SECS = 15 * 60;

const DEADLINE_ERROR_INFO = "run deadline exceeded";

type SweepThreadChat = Awaited<
  ReturnType<typeof getStalledThreadChats>
>[number];

export type RunDeadlineSweepResult = {
  scanned: number;
  terminated: number;
  skipped: number;
};

function buildDeadlineErrorMessage() {
  return {
    type: "error" as const,
    error_type: "agent-generic-error" as const,
    error_info: DEADLINE_ERROR_INFO,
    timestamp: new Date().toISOString(),
  };
}

async function driveThreadChatToTerminal({
  threadChat,
}: {
  threadChat: SweepThreadChat;
}): Promise<UpdateThreadChatWithTransitionResult> {
  return updateThreadChatWithTransition({
    userId: threadChat.userId,
    threadId: threadChat.threadId,
    threadChatId: threadChat.id,
    eventType: "system.error",
    chatUpdates: {
      replaceQueuedMessages: [],
      errorMessage: "agent-generic-error",
      errorMessageInfo: DEADLINE_ERROR_INFO,
      appendMessages: [buildDeadlineErrorMessage()],
    },
  });
}

export async function runDeadlineSweep({
  db,
  cutoffSecs = RUN_DEADLINE_CUTOFF_SECS,
}: {
  db: DB;
  cutoffSecs?: number;
}): Promise<RunDeadlineSweepResult> {
  const stalledThreadChats = await getStalledThreadChats({ db, cutoffSecs });
  let terminated = 0;
  let skipped = 0;

  for (const threadChat of stalledThreadChats) {
    try {
      const result = await driveThreadChatToTerminal({ threadChat });
      if (result.didUpdateStatus) {
        terminated += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error(
        `Run deadline sweep failed for thread chat ${threadChat.id}`,
        error,
      );
    }
  }

  return {
    scanned: stalledThreadChats.length,
    terminated,
    skipped,
  };
}
