"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { SelectedAIModels } from "@terragon/agent/types";
import { DBUserMessage, ThreadSource } from "@terragon/shared";
import { createNewThread } from "../server-lib/new-thread-shared";
import { getAccessInfoForUser } from "@/lib/subscription";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";
import { newThreadsMultiModel } from "@/server-lib/new-threads-multi-model";
import { UserFacingError } from "@/lib/server-actions";

export type NewThreadArgs = {
  message: DBUserMessage;
  githubRepoFullName: string;
  branchName: string;
  createNewBranch?: boolean;
  runInSdlcLoop?: boolean;
  parentThreadId?: string;
  parentToolId?: string;
  saveAsDraft?: boolean;
  disableGitCheckpointing?: boolean;
  skipSetup?: boolean;
  scheduleAt?: number | null;
  selectedModels?: SelectedAIModels;
  sourceType?: ThreadSource;
};

export const newThread = userOnlyAction(
  async function newThread(
    userId: string,
    {
      message,
      selectedModels,
      githubRepoFullName,
      branchName,
      parentThreadId,
      parentToolId,
      saveAsDraft,
      disableGitCheckpointing,
      skipSetup,
      createNewBranch = true,
      runInSdlcLoop = true,
      scheduleAt,
      sourceType = "www",
    }: NewThreadArgs,
  ): Promise<{ threadId: string; threadChatId: string }> {
    console.log("newThread", { userId, githubRepoFullName });
    // Gate task creation behind active access
    const { tier } = await getAccessInfoForUser(userId);
    if (tier === "none") {
      throw new UserFacingError(SUBSCRIPTION_MESSAGES.CREATE_TASK);
    }

    const baseBranchName = createNewBranch ? branchName : null;
    const headBranchName = createNewBranch ? null : branchName;
    const { threadId, threadChatId } = await createNewThread({
      userId,
      message,
      githubRepoFullName,
      baseBranchName,
      headBranchName,
      parentThreadId,
      parentToolId,
      generateName: true,
      saveAsDraft,
      scheduleAt,
      sourceType,
      sourceMetadata:
        sourceType === "www"
          ? {
              type: "www",
              sdlcLoopOptIn: runInSdlcLoop,
            }
          : undefined,
      disableGitCheckpointing,
      skipSetup,
      runInSdlcLoop,
    });
    if (selectedModels && !saveAsDraft) {
      await newThreadsMultiModel({
        userId,
        message,
        selectedModels,
        parentThreadId,
        parentToolId,
        githubRepoFullName,
        baseBranchName,
        headBranchName,
        scheduleAt,
        disableGitCheckpointing,
        skipSetup,
        runInSdlcLoop,
      });
    }
    return { threadId, threadChatId };
  },
  { defaultErrorMessage: "Failed to create task" },
);
