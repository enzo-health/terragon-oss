import { sendDaemonMessage } from "@/agent/daemon";
import { waitUntil } from "@vercel/functions";
import { getLatestAgentRunContextForThreadChat } from "@terragon/shared/model/agent-run-context";
import { db } from "@/lib/db";
import { withThreadSandboxSession } from "@/agent/thread-resource";
import { commitTerminalRunAndChatStatus } from "@/server-lib/commit-terminal-run";

const TERMINAL_RUN_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "stopped",
];

export async function stopThread({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  waitUntil(
    withThreadSandboxSession({
      label: "stop-thread",
      threadId,
      userId,
      threadChatId,
      onBeforeExec: async () => {
        const runContext = await getLatestAgentRunContextForThreadChat({
          db,
          userId,
          threadId,
          threadChatId,
        });
        const shouldFence =
          runContext !== null &&
          !TERMINAL_RUN_STATUSES.includes(runContext.status);
        const { transition } = await commitTerminalRunAndChatStatus({
          db,
          fence: shouldFence
            ? {
                runId: runContext.runId,
                userId,
                threadId,
                threadChatId,
                transportMode: runContext.transportMode,
                protocolVersion: runContext.protocolVersion,
                runtimeProvider: runContext.runtimeProvider,
                daemonTokenKeyId: runContext.daemonTokenKeyId,
                terminalStatus: "stopped",
                lastAcceptedSeq: (runContext.lastAcceptedSeq ?? 0) + 1,
                terminalEventId: `user-stop:${runContext.runId}`,
              }
            : null,
          transition: {
            userId,
            threadId,
            threadChatId,
            eventType: "user.stop",
            chatUpdates: {
              scheduleAt: null,
            },
          },
        });
        return (transition?.updatedStatus ?? undefined) !== "complete";
      },
      execOrThrow: async ({ session }) => {
        if (!session) {
          return;
        }
        await sendDaemonMessage({
          message: { type: "stop" },
          threadId,
          threadChatId,
          userId,
          sandboxId: session.sandboxId,
          session,
        });
      },
    }),
  );
}
