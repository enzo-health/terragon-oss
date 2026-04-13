"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { SelectedAIModels } from "@terragon/agent/types";
import { DBUserMessage, ThreadSource } from "@terragon/shared";
import { createNewThread } from "../server-lib/new-thread-shared";
import {
  type CreatedThreadSummary,
  type FailedThreadCreation,
  newThreadsMultiModel,
} from "@/server-lib/new-threads-multi-model";

export type NewThreadArgs = {
  message: DBUserMessage;
  githubRepoFullName: string;
  branchName: string;
  createNewBranch?: boolean;
  runInDeliveryLoop?: boolean;
  parentThreadId?: string;
  parentToolId?: string;
  saveAsDraft?: boolean;
  disableGitCheckpointing?: boolean;
  skipSetup?: boolean;
  scheduleAt?: number | null;
  selectedModels?: SelectedAIModels;
  sourceType?: ThreadSource;
};

export type NewThreadResult = {
  threadId: string;
  threadChatId: string;
  createdThreads: CreatedThreadSummary[];
  failedModels: FailedThreadCreation[];
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
      runInDeliveryLoop = true,
      scheduleAt,
      sourceType = "www",
    }: NewThreadArgs,
  ): Promise<NewThreadResult> {
    console.log("newThread", {
      userId,
      githubRepoFullName,
      createNewBranch,
      branchName,
    });
    const baseBranchName = createNewBranch ? branchName : null;
    const headBranchName = createNewBranch ? null : branchName;
    const primaryThread = await createNewThread({
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
              deliveryLoopOptIn: runInDeliveryLoop,
            }
          : undefined,
      disableGitCheckpointing,
      skipSetup,
      runInDeliveryLoop,
    });
    const createdThreads: CreatedThreadSummary[] = [
      {
        threadId: primaryThread.threadId,
        threadChatId: primaryThread.threadChatId,
        model: primaryThread.model,
      },
    ];
    let failedModels: FailedThreadCreation[] = [];
    if (selectedModels && !saveAsDraft) {
      const multiModelResult = await newThreadsMultiModel({
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
        runInDeliveryLoop,
        tolerateFailures: true,
      });
      createdThreads.push(...multiModelResult.createdThreads);
      failedModels = multiModelResult.failedModels;
    }
    return {
      threadId: primaryThread.threadId,
      threadChatId: primaryThread.threadChatId,
      createdThreads,
      failedModels,
    };
  },
  { defaultErrorMessage: "Failed to create task" },
);
