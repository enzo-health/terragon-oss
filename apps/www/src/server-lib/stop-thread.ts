import { sendDaemonMessage } from "@/agent/daemon";
import { waitUntil } from "@vercel/functions";
import { withThreadSandboxSession } from "@/agent/thread-resource";
import { updateThreadChatWithTransition } from "@/agent/update-status";

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
        const { updatedStatus } = await updateThreadChatWithTransition({
          userId,
          threadId,
          threadChatId,
          eventType: "user.stop",
          chatUpdates: {
            scheduleAt: null,
          },
        });
        return updatedStatus !== "complete";
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
