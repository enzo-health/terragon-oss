import { useCallback, useEffect, useMemo, useRef } from "react";
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
  // React-Query's mutation object gets a new reference on every render
  // (isPending/status changes re-render this hook). Depending on it in a
  // useCallback/useEffect created an unbounded loop because each mutation
  // invocation re-rendered the hook, produced a fresh `markAsRead`, and re-
  // fired the effect before `onMutate` had flipped `threadIsUnread` to
  // false. Latch the in-flight chat-id in a ref and depend only on primitive
  // inputs so the effect fires at most once per (threadId, threadChatId).
  const mutateAsync = readThreadMutation.mutateAsync;
  const inflightForChatIdRef = useRef<string | null>(null);
  const isDocumentVisible = useDocumentVisibility();
  useEffect(() => {
    if (isReadOnly) {
      return;
    }
    if (!threadChatId) {
      return;
    }
    if (!threadIsUnread || !isDocumentVisible) {
      return;
    }
    if (inflightForChatIdRef.current === threadChatId) {
      return;
    }
    inflightForChatIdRef.current = threadChatId;
    mutateAsync({
      threadId,
      threadChatIdOrNull: threadChatId,
    }).catch(() => {
      // Allow retry on next visibility / unread transition after a failure.
      if (inflightForChatIdRef.current === threadChatId) {
        inflightForChatIdRef.current = null;
      }
    });
    // NB: on success we intentionally keep the latch set. `threadIsUnread`
    // will have flipped to false via onMutate, so the effect short-circuits
    // until something else marks the chat unread again — at which point the
    // chatId will typically be the same, and the optimistic cache write
    // dedupes the server call for us.
  }, [
    threadId,
    threadChatId,
    threadIsUnread,
    isDocumentVisible,
    isReadOnly,
    mutateAsync,
  ]);
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
          const nextProjectedMessages =
            updates.projectedMessages ??
            updates.messages ??
            oldData.projectedMessages ??
            oldData.messages ??
            [];
          return {
            ...oldData,
            ...updates,
            projectedMessages: nextProjectedMessages,
            messageCount: nextProjectedMessages.length,
          };
        },
      );
    },
    [queryClient, threadId, threadChatId],
  );
}

export function computeShouldShowApprove({
  canApprove,
  toolPartId,
  messages,
}: {
  canApprove: boolean;
  toolPartId?: string;
  messages: DBMessage[];
}): boolean {
  if (!canApprove || !toolPartId) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === "user") break;
    if (msg?.type === "tool-call" && msg.name === "ExitPlanMode") {
      return msg.id === toolPartId;
    }
  }
  return false;
}

export function usePlanApproval({
  threadId,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  toolPartId,
  messages,
}: {
  threadId: string | undefined;
  threadChatId: string | undefined;
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

  const canApprove = !isReadOnly && !!threadId && !!threadChatId;

  const shouldShowApprove = useMemo(
    () => computeShouldShowApprove({ canApprove, toolPartId, messages }),
    [canApprove, toolPartId, messages],
  );

  const handleApprove = useCallback(async () => {
    if (!canApprove) return;
    // Optimistic: update UI immediately for responsiveness
    promptBoxRef?.current?.setPermissionMode("allowAll");
    updateThreadChat({ permissionMode: "allowAll" });
    try {
      await mutateAsync({ threadId, threadChatId });
    } catch {
      // Rollback optimistic updates on failure
      promptBoxRef?.current?.setPermissionMode("plan");
      updateThreadChat({ permissionMode: "plan" });
    }
  }, [
    canApprove,
    threadId,
    threadChatId,
    promptBoxRef,
    mutateAsync,
    updateThreadChat,
  ]);

  return { handleApprove, isPending, shouldShowApprove };
}
