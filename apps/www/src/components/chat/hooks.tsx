import { useCallback, useEffect, useMemo } from "react";
import { useReadThreadMutation } from "@/queries/thread-mutations";
import { getThreadDocumentTitle } from "@/agent/thread-utils";
import { useDocumentVisibility } from "@/hooks/useDocumentVisibility";
import { secondaryPaneClosedAtom } from "@/atoms/user-cookies";
import { atom, useAtom } from "jotai";
import { usePlatform } from "@/hooks/use-platform";
import { threadQueryKeys } from "@/queries/thread-queries";
import { ThreadPageChat } from "@terragon/shared/db/types";
import { useQueryClient } from "@tanstack/react-query";
import type { DBMessage } from "@terragon/shared";
import type { PromptBoxRef } from "./thread-context";
import { approvePlan } from "@/server-actions/approve-plan";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function useMarkChatAsRead({
  threadId,
  threadChatId,
  threadIsUnread,
  isReadOnly,
}: {
  threadId: string;
  threadChatId: string | undefined;
  threadIsUnread: boolean;
  isReadOnly: boolean;
}) {
  const readThreadMutation = useReadThreadMutation();
  const markAsRead = useCallback(async () => {
    if (threadChatId) {
      await readThreadMutation.mutateAsync({
        threadId,
        threadChatIdOrNull: threadChatId,
      });
    }
  }, [threadId, threadChatId, readThreadMutation]);
  // Mark thread as read when it becomes visible
  const isDocumentVisible = useDocumentVisibility();
  useEffect(() => {
    if (isReadOnly) {
      return;
    }
    if (threadIsUnread && isDocumentVisible) {
      markAsRead();
    }
  }, [threadIsUnread, isDocumentVisible, markAsRead, isReadOnly]);
}

export function useThreadDocumentTitleAndFavicon({
  name,
  isThreadUnread,
  isReadOnly,
}: {
  name: string;
  isThreadUnread: boolean;
  isReadOnly: boolean;
}) {
  // Update document title and favicon based on unread messages
  const documentTitle = name
    ? getThreadDocumentTitle({ name, isUnread: isThreadUnread })
    : "Terragon";
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.title = documentTitle;
    // Update favicon
    const favicon = document.querySelector(
      "link[rel*='icon']",
    ) as HTMLLinkElement;
    if (favicon) {
      if (process.env.NODE_ENV === "development") {
        favicon.href =
          isThreadUnread && !isReadOnly
            ? "/favicon-dev-badged.png"
            : "/favicon-dev.png";
      } else {
        favicon.href =
          isThreadUnread && !isReadOnly
            ? "/favicon-badged.png"
            : "/favicon.png";
      }
    }
  }, [documentTitle, isThreadUnread, isReadOnly]);
}

const secondaryPanelIsOpenLocalAtom = atom<boolean>(false);

export function useSecondaryPanel() {
  const platform = usePlatform();
  const [isSecondaryPanelOpenLocal, setIsSecondaryPanelOpenLocal] = useAtom(
    secondaryPanelIsOpenLocalAtom,
  );
  const [isSecondaryPaneClosedCookie, setIsSecondaryPaneClosedCookie] = useAtom(
    secondaryPaneClosedAtom,
  );
  const setIsSecondaryPanelOpen = useCallback(
    (open: boolean) => {
      setIsSecondaryPanelOpenLocal(open);
      setIsSecondaryPaneClosedCookie(!open);
    },
    [setIsSecondaryPanelOpenLocal, setIsSecondaryPaneClosedCookie],
  );
  return {
    shouldAutoOpenSecondaryPanel:
      platform === "desktop" && !isSecondaryPaneClosedCookie,
    isSecondaryPanelOpen: isSecondaryPanelOpenLocal,
    setIsSecondaryPanelOpen,
  };
}

export function useOptimisticUpdateThreadChat({
  threadId,
  threadChatId,
}: {
  threadId: string | undefined;
  threadChatId: string | undefined;
}) {
  const queryClient = useQueryClient();

  type ThreadChatOptimisticUpdates =
    | Partial<ThreadPageChat>
    | ((currentChat: ThreadPageChat) => Partial<ThreadPageChat>);

  return useCallback(
    (updatesOrUpdater: ThreadChatOptimisticUpdates) => {
      if (!threadId || !threadChatId) {
        return;
      }
      queryClient.setQueryData<ThreadPageChat>(
        threadQueryKeys.chat(threadId, threadChatId),
        (oldData) => {
          if (!oldData) return oldData;
          const updates =
            typeof updatesOrUpdater === "function"
              ? updatesOrUpdater(oldData)
              : updatesOrUpdater;
          const nextMessages = updates.messages ?? oldData.messages ?? [];
          return {
            ...oldData,
            ...updates,
            messages: nextMessages,
            messageCount: nextMessages.length,
          };
        },
      );
    },
    [queryClient, threadId, threadChatId],
  );
}

export function usePlanApproval({
  threadId,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  toolPartId,
  messages,
}: {
  threadId: string;
  threadChatId: string;
  isReadOnly: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  toolPartId?: string;
  messages: DBMessage[];
}) {
  const { mutateAsync, isPending } = useServerActionMutation({
    mutationFn: approvePlan,
  });
  const updateThreadChat = useOptimisticUpdateThreadChat({
    threadId,
    threadChatId,
  });

  const shouldShowApprove = useMemo(() => {
    if (isReadOnly || !toolPartId) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.type === "user") break;
      if (msg?.type === "tool-call" && msg.name === "ExitPlanMode") {
        return msg.id === toolPartId;
      }
    }
    return false;
  }, [isReadOnly, toolPartId, messages]);

  const handleApprove = useCallback(async () => {
    if (isReadOnly) return;
    promptBoxRef?.current?.setPermissionMode("allowAll");
    updateThreadChat({ permissionMode: "allowAll" });
    await mutateAsync({ threadId, threadChatId });
  }, [
    isReadOnly,
    threadId,
    threadChatId,
    promptBoxRef,
    mutateAsync,
    updateThreadChat,
  ]);

  return { handleApprove, isPending, shouldShowApprove };
}
