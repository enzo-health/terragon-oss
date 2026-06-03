import { UIAgentMessage, UIUserMessage } from "@terragon/shared";
import { MessagePartProps } from "./message-part";

export type { RedoDialogData, ForkDialogData } from "./dialog-data";

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

export const DEFAULT_MESSAGE_PART_PROPS: MessagePartRenderProps = {
  githubRepoFullName: "",
  branchName: null,
  baseBranchName: "main",
  hasCheckpoint: false,
  toolProps: {
    threadId: "",
    threadChatId: "",
    isReadOnly: false,
    childThreads: [],
    githubRepoFullName: "",
    repoBaseBranchName: "main",
    branchName: null,
  },
};
