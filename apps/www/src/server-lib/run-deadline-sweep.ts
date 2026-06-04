import { getStalledThreadChats } from "@terragon/shared/model/threads";
import { DB } from "@terragon/shared/db";
import { maybeHibernateSandboxById } from "@/agent/sandbox";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { updateThreadChatWithTransition } from "@/agent/update-status";

export const RUN_DEADLINE_CUTOFF_SECS = 15 * 60;

const DEADLINE_ERROR_INFO = "run deadline exceeded";
const HIBERNATE_BATCH_SIZE = 10;

type SweepThreadChat = Awaited<
  ReturnType<typeof getStalledThreadChats>
>[number];

export type RunDeadlineSweepResult = {
  scanned: number;
  terminated: number;
  skipped: number;
};

// Drive a stalled run to a terminal status through the machine transition (and the
// thread.status_changed broadcast it emits), NOT a bulk UPDATE — so the composer
// de-latches instead of waiting for a refresh. `system.error` is a no-op on rows
// already terminal, so the sweep is idempotent and safe to run on every tick.
async function terminateStalledThreadChat(
  threadChat: SweepThreadChat,
): Promise<boolean> {
  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId: threadChat.userId,
    threadId: threadChat.threadId,
    threadChatId: threadChat.id,
    eventType: "system.error",
    chatUpdates: {
      replaceQueuedMessages: [],
      errorMessage: "agent-generic-error",
      errorMessageInfo: DEADLINE_ERROR_INFO,
      appendMessages: [
        {
          type: "error",
          error_type: "agent-generic-error",
          error_info: DEADLINE_ERROR_INFO,
          timestamp: new Date().toISOString(),
        },
      ],
    },
  });
  return didUpdateStatus;
}

async function releaseStalledSandboxes(
  threadChats: SweepThreadChat[],
): Promise<void> {
  for (const threadChat of threadChats) {
    if (!threadChat.codesandboxId) continue;
    try {
      await setActiveThreadChat({
        sandboxId: threadChat.codesandboxId,
        threadChatId: threadChat.id,
        isActive: false,
      });
    } catch (error) {
      console.error(
        `Run deadline sweep: Redis cleanup failed for thread chat ${threadChat.id}`,
        error,
      );
    }
  }

  const sandboxes = new Map(
    threadChats
      .filter((tc) => tc.codesandboxId)
      .map((tc) => [
        tc.codesandboxId!,
        {
          threadId: tc.threadId,
          userId: tc.userId,
          sandboxProvider: tc.sandboxProvider,
        },
      ]),
  );
  const entries = Array.from(sandboxes.entries());
  for (let i = 0; i < entries.length; i += HIBERNATE_BATCH_SIZE) {
    await Promise.all(
      entries
        .slice(i, i + HIBERNATE_BATCH_SIZE)
        .map(([sandboxId, { threadId, userId, sandboxProvider }]) =>
          maybeHibernateSandboxById({
            threadId,
            userId,
            sandboxId,
            sandboxProvider,
          }).catch(() => {}),
        ),
    );
  }
}

/**
 * The single authority for stalled thread-chats: any run whose `updatedAt` has gone
 * silent past the cutoff is driven to a terminal status through the transition path
 * and its sandbox is hibernated. Run on a fast cadence so a lost daemon terminal
 * converges in minutes; idempotent, so re-runs on the same rows are no-ops.
 */
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
      if (await terminateStalledThreadChat(threadChat)) {
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

  await releaseStalledSandboxes(stalledThreadChats);

  return {
    scanned: stalledThreadChats.length,
    terminated,
    skipped,
  };
}
