"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { getThreadMinimal } from "@leo/shared/model/threads";
import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { DBSystemMessage } from "@leo/shared";
import { sendSystemMessage } from "@/server-lib/send-system-message";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { UserFacingError } from "@/lib/server-actions";

export const fixGithubChecks = userOnlyAction(
  async function fixGithubChecks(
    userId: string,
    {
      threadId,
      threadChatId,
    }: {
      threadId: string;
      threadChatId: string;
    },
  ) {
    console.log("fixGithubChecks", { threadId, threadChatId });
    const thread = await getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "fix_github_checks",
      properties: {
        threadId,
        threadChatId,
      },
    });

    const systemFixGithubChecksMessage: DBSystemMessage = {
      type: "system",
      message_type: "fix-github-checks",
      parts: [
        {
          type: "text",
          text: 'Please fix the failing GitHub checks for this PR. Use "gh pr checks" to get the CI check failures.',
        },
      ],
    };
    const sandboxId = thread.codesandboxId!;
    await setActiveThreadChat({
      sandboxId,
      threadChatId,
      isActive: true,
    });
    await sendSystemMessage({
      userId,
      threadId,
      threadChatId,
      message: systemFixGithubChecksMessage,
    });
    return true;
  },
  { defaultErrorMessage: "Unexpected error occurred" },
);
