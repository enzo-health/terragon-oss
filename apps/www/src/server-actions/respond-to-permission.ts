"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { sendDaemonMessage } from "@/agent/daemon";
import { withThreadSandboxSession } from "@/agent/thread-resource";

export const respondToPermission = userOnlyAction(
  async function respondToPermission(
    userId: string,
    {
      threadId,
      threadChatId,
      promptId,
      optionId,
    }: {
      threadId: string;
      threadChatId: string;
      promptId: string;
      optionId: string;
    },
  ) {
    await withThreadSandboxSession({
      label: "permission-response",
      threadId,
      userId,
      threadChatId,
      execOrThrow: async ({ session }) => {
        if (!session) return;
        await sendDaemonMessage({
          message: { type: "permission-response", promptId, optionId },
          threadId,
          threadChatId,
          userId,
          sandboxId: session.sandboxId,
          session,
        });
      },
    });
  },
  { defaultErrorMessage: "Failed to respond to permission request" },
);
