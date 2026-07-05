"use client";

import { createContext, use } from "react";

export type PermissionDecision = "approved" | "denied";

export type ConversationContextValue = {
  readonly isReadOnly: boolean;
  readonly respondToPermission?: (
    permissionRequestId: string,
    optionId: PermissionDecision,
  ) => void;
  readonly onOpenRepoFile?: (href: string) => void;
};

const ConversationContext = createContext<ConversationContextValue>({
  isReadOnly: false,
});

export const ConversationContextProvider = ConversationContext.Provider;

export function useConversationContext(): ConversationContextValue {
  return use(ConversationContext);
}
