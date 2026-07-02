"use server";

import { DBUserMessage } from "@terragon/shared";
import { userOnlyAction } from "@/lib/auth-server";
import { withFollowUpSubmissionGuard } from "@/server-lib/ag-ui/follow-up-submission-guard";
import {
  followUpInternal,
  queueFollowUpInternal,
} from "@/server-lib/follow-up";

export type FollowUpArgs = {
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
  clientSubmissionId?: string | null;
};

export const followUp = userOnlyAction(
  async function followUp(
    userId: string,
    {
      threadId,
      threadChatId,
      message,
      clientSubmissionId = null,
    }: {
      threadId: string;
      threadChatId: string;
      message: DBUserMessage;
      clientSubmissionId?: string | null;
    },
  ) {
    console.log("followUp", { threadId, threadChatId });
    // Mirror the AG-UI append path's run-lock so this fallback path can't
    // dispatch a second concurrent run on the same thread chat. When callers
    // thread a clientSubmissionId (the composer/comment fallbacks now do), this
    // also gets the same per-submission dedupe the append path relies on; a
    // duplicate resolves as a silent no-op rather than a second run.
    const guarded = await withFollowUpSubmissionGuard({
      userId,
      threadId,
      threadChatId,
      clientSubmissionId,
      dispatch: async (markDispatched) => {
        await followUpInternal({
          userId,
          threadId,
          threadChatId,
          message,
          source: "www",
        });
        markDispatched();
      },
    });
    if (guarded.type === "lock-held") {
      throw new Error("Run already in progress");
    }
  },
  { defaultErrorMessage: "Failed to submit follow up" },
);

export type QueueFollowUpArgs = {
  threadId: string;
  threadChatId: string;
  messages: DBUserMessage[];
};

export const queueFollowUp = userOnlyAction(
  async function queueFollowUp(
    userId: string,
    {
      threadId,
      threadChatId,
      messages,
    }: {
      threadId: string;
      threadChatId: string;
      messages: DBUserMessage[];
    },
  ) {
    console.log("queueFollowUp", { threadId, threadChatId });
    await queueFollowUpInternal({
      userId,
      threadId,
      threadChatId,
      messages,
      source: "www",
      appendOrReplace: "replace",
    });
  },
  { defaultErrorMessage: "Failed to queue follow-up" },
);
