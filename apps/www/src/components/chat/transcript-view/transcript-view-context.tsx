"use client";

import { createContext, use } from "react";

export type PermissionDecision = "approved" | "denied";

export type TranscriptViewContextValue = {
  readonly isReadOnly: boolean;
  readonly respondToPermission?: (
    permissionRequestId: string,
    optionId: PermissionDecision,
  ) => void;
  readonly onOpenRepoFile?: (href: string) => void;
};

const TranscriptViewContext = createContext<TranscriptViewContextValue>({
  isReadOnly: false,
});

export const TranscriptViewContextProvider = TranscriptViewContext.Provider;

export function useTranscriptViewContext(): TranscriptViewContextValue {
  return use(TranscriptViewContext);
}
