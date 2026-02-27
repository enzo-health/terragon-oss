import { useCallback, useEffect } from "react";
import { useReadThreadMutation } from "@/queries/thread-mutations";
import { getThreadDocumentTitle } from "@/agent/thread-utils";
import { useDocumentVisibility } from "@/hooks/useDocumentVisibility";
import { secondaryPaneClosedAtom } from "@/atoms/user-cookies";
import { atom, useAtom } from "jotai";
import { usePlatform } from "@/hooks/use-platform";
import { threadQueryKeys } from "@/queries/thread-queries";
import { ThreadChatInfoFull, ThreadInfoFull } from "@terragon/shared/db/types";
import { useQueryClient } from "@tanstack/react-query";

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
const secondaryPanelModeAtom = atom<"diff" | "preview">("diff");

export function useSecondaryPanel() {
  const platform = usePlatform();
  const [isSecondaryPanelOpenLocal, setIsSecondaryPanelOpenLocal] = useAtom(
    secondaryPanelIsOpenLocalAtom,
  );
  const [secondaryPanelMode, setSecondaryPanelMode] = useAtom(
    secondaryPanelModeAtom,
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
    secondaryPanelMode,
    setIsSecondaryPanelOpen,
    setSecondaryPanelMode,
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
  return useCallback(
    (updates: Partial<ThreadChatInfoFull>) => {
      if (!threadId || !threadChatId) {
        return;
      }
      queryClient.setQueryData<ThreadInfoFull>(
        threadQueryKeys.detail(threadId),
        (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            threadChats: oldData.threadChats.map((tc) =>
              tc.id === threadChatId ? { ...tc, ...updates } : tc,
            ),
          };
        },
      );
    },
    [queryClient, threadId, threadChatId],
  );
}
