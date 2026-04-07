import {
  DBUserMessage,
  GitDiffStats,
  UIAgentMessage,
  UIUserMessage,
} from "@terragon/shared";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { MessagePartProps } from "./message-part";

export type UIUserOrAgentPart =
  | UIAgentMessage["parts"][number]
  | UIUserMessage["parts"][number];

export type PartGroup = {
  type: UIUserOrAgentPart["type"] | "collapsible-agent-activity";
  parts: UIUserOrAgentPart[];
};

export type MessagePartRenderProps = Pick<
  MessagePartProps,
  | "githubRepoFullName"
  | "branchName"
  | "baseBranchName"
  | "hasCheckpoint"
  | "toolProps"
>;

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

export const DEFAULT_MESSAGE_PART_PROPS: MessagePartRenderProps = {
  githubRepoFullName: "",
  branchName: null,
  baseBranchName: "main",
  hasCheckpoint: false,
  toolProps: {
    threadId: "",
    threadChatId: "",
    messages: [],
    isReadOnly: false,
    childThreads: [],
    githubRepoFullName: "",
    repoBaseBranchName: "main",
    branchName: null,
  },
};
