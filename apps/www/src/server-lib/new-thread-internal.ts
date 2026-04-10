import {
  Automation,
  DBUserMessage,
  ThreadSource,
  ThreadSourceMetadata,
} from "@leo/shared";
import { createNewThread } from "./new-thread-shared";

/**
 * Internal version of newThread that accepts userId as a parameter.
 * This is used by webhooks and other background processes that don't have access to session context.
 */
export async function newThreadInternal({
  userId,
  message,
  githubRepoFullName,
  baseBranchName,
  headBranchName,
  parentThreadId,
  parentToolId,
  automation,
  githubPRNumber,
  githubIssueNumber,
  sourceType,
  sourceMetadata,
}: {
  userId: string;
  message: DBUserMessage;
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  parentThreadId?: string;
  parentToolId?: string;
  automation?: Automation;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  sourceType: ThreadSource;
  sourceMetadata?: ThreadSourceMetadata;
}) {
  console.log("newThreadInternal for user", {
    userId,
    sourceType,
    githubRepoFullName,
  });
  // Use the shared function to create the thread
  return await createNewThread({
    userId,
    message,
    githubRepoFullName,
    baseBranchName,
    headBranchName,
    parentThreadId,
    parentToolId,
    automation,
    generateName: true,
    githubPRNumber,
    githubIssueNumber,
    sourceType,
    sourceMetadata,
  });
}
