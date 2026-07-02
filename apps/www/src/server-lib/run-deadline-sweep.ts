import { getStalledThreadChats } from "@terragon/shared/model/threads";
import { getLatestAgentRunContextForThreadChat } from "@terragon/shared/model/agent-run-context";
import { DB } from "@terragon/shared/db";
import { maybeHibernateSandboxById } from "@/agent/sandbox";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { commitTerminalRunAndChatStatus } from "@/server-lib/commit-terminal-run";

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

// Drive a stalled run to terminal through the derived-status choke point: fence the
// run-context (so a late daemon event from the dead run can't pass the route's
// active-run guards and append to the swept transcript) AND apply the `system.error`
// chat transition (with the thread.status_changed broadcast it emits) in ONE
// transaction. The stalled row carries no runId, so resolve the newest run first.
// Fenced + idempotent: terminalEventId is keyed to the runId (a re-run returns
// "duplicate"), and the CAS self-rejects if a newer run has already superseded this
// one — so it can never stomp a live successor. Rows with no run-context still get the
// chat transition.
async function terminateStalledThreadChat(
  db: DB,
  threadChat: SweepThreadChat,
): Promise<boolean> {
  const runContext = await getLatestAgentRunContextForThreadChat({
    db,
    userId: threadChat.userId,
    threadId: threadChat.threadId,
    threadChatId: threadChat.id,
  });
  const { transition } = await commitTerminalRunAndChatStatus({
    db,
    fence: runContext
      ? {
          runId: runContext.runId,
          userId: runContext.userId,
          threadId: runContext.threadId,
          threadChatId: runContext.threadChatId,
          transportMode: runContext.transportMode,
          protocolVersion: runContext.protocolVersion,
          runtimeProvider: runContext.runtimeProvider,
          daemonTokenKeyId: runContext.daemonTokenKeyId,
          terminalStatus: "failed",
          lastAcceptedSeq: (runContext.lastAcceptedSeq ?? 0) + 1,
          terminalEventId: `deadline-sweep:${runContext.runId}`,
          failureUpdates: {
            failureSource: "custom-error",
            failureTerminalReason: DEADLINE_ERROR_INFO,
          },
        }
      : null,
    transition: {
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
    },
    // The sweep favours a terminal `complete` on the rare reconcile path (a real
    // terminal landed between the read and the CAS) rather than a checkpoint-pending
    // state; the sweep never checkpoints.
    disableGitCheckpointing: true,
  });
  return transition?.didUpdateStatus ?? false;
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
      if (await terminateStalledThreadChat(db, threadChat)) {
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
