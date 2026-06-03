"use client";

import { createContext, use } from "react";
import type { ThreadInfoFull, UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { ArtifactDescriptorLookup } from "../secondary-panel-helpers";
import type { PromptBoxRef } from "../thread-context";
import type { RedoDialogData, ForkDialogData } from "../dialog-data";

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
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact: (artifactId: string) => void;
  /** Opens an in-repo file link (from markdown text) in the artifacts panel. */
  onOpenRepoFile?: (href: string) => void;
  planOccurrences: Map<UIPart, number>;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  toolProps: {
    threadId: string;
    threadChatId: string;
    isReadOnly: boolean;
    promptBoxRef?: React.RefObject<PromptBoxRef | null>;
    childThreads: { id: string; parentToolId: string | null }[];
    githubRepoFullName: string;
    repoBaseBranchName: string;
    branchName: string | null;
    onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
  };
};

const Context = createContext<TerragonThreadContext | null>(null);

export const TerragonThreadProvider = Context.Provider;

export function useTerragonThread(): TerragonThreadContext {
  const ctx = use(Context);
  if (!ctx) {
    throw new Error(
      "useTerragonThread must be used within a TerragonThreadProvider",
    );
  }
  return ctx;
}
