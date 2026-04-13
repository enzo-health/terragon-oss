"use client";

import { createContext, useContext } from "react";
import type {
  DBMessage,
  ThreadInfoFull,
  UIMessage,
  UIPart,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { PromptBoxRef } from "../thread-context";
import type { RedoDialogData, ForkDialogData } from "../chat-message.types";

export type TerragonThreadContext = {
  messages: UIMessage[];
  thread: ThreadInfoFull | null;
  latestGitDiffTimestamp: string | null;
  isAgentWorking: boolean;
  latestAgentMessageIndex: number;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  planOccurrences: Map<UIPart, number>;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  toolProps: {
    threadId: string;
    threadChatId: string;
    messages: DBMessage[];
    isReadOnly: boolean;
    promptBoxRef?: React.RefObject<PromptBoxRef | null>;
    childThreads: { id: string; parentToolId: string | null }[];
    githubRepoFullName: string;
    repoBaseBranchName: string;
    branchName: string | null;
  };
  githubRepoFullName: string;
  branchName: string | null;
  baseBranchName: string;
  hasCheckpoint: boolean;
};

const Context = createContext<TerragonThreadContext | null>(null);

export const TerragonThreadProvider = Context.Provider;

export function useTerragonThread(): TerragonThreadContext {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      "useTerragonThread must be used within a TerragonThreadProvider",
    );
  }
  return ctx;
}
