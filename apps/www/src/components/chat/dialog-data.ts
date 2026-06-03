import { DBUserMessage, GitDiffStats } from "@terragon/shared";
import { AIAgent, AIModel } from "@terragon/agent/types";

export type RedoDialogData = {
  threadId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  permissionMode: "allowAll" | "plan";
  initialUserMessage: DBUserMessage;
};

export type ForkDialogData = {
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  branchName: string | null;
  gitDiffStats: GitDiffStats | null;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  agent: AIAgent;
  lastSelectedModel: AIModel | null;
};
