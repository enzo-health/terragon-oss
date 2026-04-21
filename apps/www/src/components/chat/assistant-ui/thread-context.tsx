"use client";

import { createContext, useContext } from "react";
import type { DBMessage, ThreadInfoFull, UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { PromptBoxRef } from "../thread-context";
import type {
  RedoDialogData,
  ForkDialogData,
  MessagePartRenderProps,
} from "../chat-message.types";

/**
 * Thread-level context. Values here are intentionally stable across
 * streaming token deltas: fields that churn (e.g. the full `UIMessage[]`,
 * or per-delta-recomputed `planOccurrences`) are either kept out of this
 * context entirely or wrapped with a reference-stabilizer at the source.
 *
 * Per-message flags like `isLatestMessage` and `isFirstUserMessage` are
 * passed as explicit props by `TerragonThread`'s `messages.map()` loop
 * — NOT read from context — so message components can be memoized.
 */
export type TerragonThreadContext = {
  thread: ThreadInfoFull | null;
  latestGitDiffTimestamp: string | null;
  isAgentWorking: boolean;
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
  /**
   * Pre-assembled `messagePartProps` bag. Kept stable across renders via
   * `useMemo` in `TerragonThread`. Per-message components pass this
   * through to `ChatMessage` without reallocation, so `ChatMessage`'s
   * memo-compare on `messagePartProps` succeeds during streaming.
   */
  messagePartProps: MessagePartRenderProps;
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
