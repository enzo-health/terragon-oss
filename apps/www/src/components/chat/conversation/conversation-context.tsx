"use client";

import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { createContext, use } from "react";

export type PermissionDecision = "approved" | "denied";

export type ConversationContextValue = {
  readonly isReadOnly: boolean;
  readonly respondToPermission?: (
    permissionRequestId: string,
    optionId: PermissionDecision,
  ) => void;
  readonly onOpenRepoFile?: (href: string) => void;
  readonly onOpenArtifact?: (artifactId: string) => void;
  readonly artifactDescriptors?: ArtifactDescriptor[];
};

const ConversationContext = createContext<ConversationContextValue>({
  isReadOnly: false,
});

export const ConversationContextProvider = ConversationContext.Provider;

export function useConversationContext(): ConversationContextValue {
  return use(ConversationContext);
}
