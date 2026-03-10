"use client";

import { useState, useMemo, ReactNode, useCallback } from "react";
import { ThreadInfo } from "@terragon/shared";
import { SheetOrMenu, SheetOrMenuItem } from "./ui/sheet-or-menu";
import {
  useArchiveMutation,
  useDeleteThreadMutation,
  useReadThreadMutation,
  useUnreadThreadMutation,
} from "@/queries/thread-mutations";
import { TaskDeleteConfirmationModal } from "./delete-confirmation-dialog";
import { RedoTaskDialog } from "./chat/redo-task-dialog";
import { useAtomValue } from "jotai";
import { userFlagsAtom } from "@/atoms/user-flags";
import { userAtom } from "@/atoms/user";
import { openPullRequest } from "@/server-actions/pull-request";
import { useRouter } from "next/navigation";
import { useIsSmallScreen } from "@/hooks/useMediaQuery";
import {
  RotateCcw,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash,
  ExternalLink,
  MailOpen,
  Mail,
  Globe,
  Lock,
  Users,
  ChevronRight,
  Terminal,
} from "lucide-react";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import type { DBUserMessage } from "@terragon/shared";

export function ThreadMenuDropdown({
  thread,
  trigger,

  // Feature toggles
  showRedoTaskAction = false,
  showPullRequestActions = false,
  showRenameAction = false,
  showReadUnreadActions = false,
  showShareAction = false,
  isReadOnly = false,
  redoDialogData,
  // Event handlers
  onRenameClick,
  onMenuOpenChange,
  onShareClick,
  onTerminalClick,
}: {
  thread: ThreadInfo;
  trigger: ReactNode;

  showRedoTaskAction?: boolean;
  showPullRequestActions?: boolean;
  showRenameAction?: boolean;
  showReadUnreadActions?: boolean;
  showShareAction?: boolean;
  isReadOnly?: boolean;
  redoDialogData?: {
    threadId: string;
    repoFullName: string;
    repoBaseBranchName: string;
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    permissionMode: "allowAll" | "plan";
    initialUserMessage: DBUserMessage;
  };
  // Event handlers
  onRenameClick?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  onShareClick?: () => void;
  onTerminalClick?: () => void;
}) {
  const router = useRouter();
  const isSmallScreen = useIsSmallScreen();
  const [showDeleteDialogState, setShowDeleteDialogState] = useState(false);
  const [showRedoTaskDialog, setShowRedoTaskDialog] = useState(false);
  const archiveMutation = useArchiveMutation();
  const deleteMutation = useDeleteThreadMutation();
  const readMutation = useReadThreadMutation();
  const unreadMutation = useUnreadThreadMutation();
  const userFlags = useAtomValue(userFlagsAtom);
  const user = useAtomValue(userAtom);
  const isDraft = !!thread.draftMessage;
  const showShareItem = showShareAction && isSmallScreen && !isDraft;
  const openPullRequestMutation = useServerActionMutation({
    mutationFn: openPullRequest,
  });
  // Use a function to check this to avoid stale state
  const isViewingThread = useCallback(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.location.pathname.startsWith(`/task/${thread.id}`);
  }, [thread.id]);

  const menuItems = useMemo(() => {
    const items: SheetOrMenuItem[] = [];

    // PR actions on small screens
    if (showPullRequestActions && isSmallScreen) {
      if (thread.githubPRNumber) {
        items.push({
          type: "link",
          label: "View Pull Request",
          icon: ExternalLink,
          href: `https://github.com/${thread.githubRepoFullName}/pull/${thread.githubPRNumber}`,
          target: "_blank",
        });
      } else {
        items.push({
          type: "button" as const,
          label: "Create Pull Request",
          icon: ExternalLink,
          onSelect: async () => {
            await openPullRequestMutation.mutateAsync({ threadId: thread.id });
          },
        });
      }
    }

    // Share action on small screens
    if (showShareItem) {
      const visibility = thread.visibility || "private";
      const getShareIcon = () => {
        switch (visibility) {
          case "private":
            return Lock;
          case "link":
            return Globe;
          case "repo":
            return Users;
          default:
            return Lock;
        }
      };

      items.push({
        type: "button" as const,
        label: "Share",
        icon: getShareIcon(),
        rightIcon: ChevronRight,
        onSelect: () => {
          onShareClick?.();
        },
      });
    }

    // Stop here for read-only users - they only get PR and Share actions
    if (isReadOnly) {
      return items;
    }

    // Add separator after share button if it exists and there are more actions
    if (showShareItem) {
      items.push({ type: "separator" as const });
    }

    // Read/Unread actions
    if (showReadUnreadActions && !isDraft) {
      if (thread.isUnread) {
        items.push({
          type: "button",
          label: "Mark as read",
          icon: MailOpen,
          onSelect: () => {
            readMutation.mutate({
              threadId: thread.id,
              threadChatIdOrNull: null,
            });
          },
        });
      } else {
        items.push({
          type: "button",
          label: "Mark as unread",
          icon: Mail,
          onSelect: () => {
            unreadMutation.mutate({ threadId: thread.id });
          },
        });
      }
    }

    // Rename
    if (showRenameAction && onRenameClick && !isDraft) {
      items.push({
        type: "button" as const,
        label: "Rename",
        icon: Pencil,
        onSelect: onRenameClick,
      });
    }

    // Retry
    if (showRedoTaskAction && redoDialogData && !isDraft) {
      items.push({
        type: "button" as const,
        label: "Retry",
        icon: RotateCcw,
        onSelect: () => setShowRedoTaskDialog(true),
      });
    }

    // Archive/Unarchive
    items.push({
      type: "button" as const,
      label: thread.archived ? "Unarchive" : "Archive",
      icon: thread.archived ? ArchiveRestore : Archive,
      onSelect: async () => {
        const isArchiving = !thread.archived;
        // Use mutateAsync to wait for the mutation to complete instead of onSuccess
        // because the component can unmount as a result of the mutation.
        await archiveMutation.mutateAsync({
          threadId: thread.id,
          archive: !thread.archived,
        });
        if (isArchiving && isViewingThread()) {
          router.push("/dashboard");
        }
      },
    });

    // Terminal action (only when sandbox is running)
    if (onTerminalClick && thread.codesandboxId && !isDraft) {
      items.push({
        type: "button" as const,
        label: "Terminal",
        icon: Terminal,
        onSelect: onTerminalClick,
      });
    }

    // Delete
    items.push({
      type: "button" as const,
      label: "Delete",
      icon: Trash,
      destructive: true,
      onSelect: () => {
        setShowDeleteDialogState(true);
      },
    });

    // Debug tools - always show if user flags enable them
    if (userFlags?.showDebugTools) {
      const debugStr = [
        `v${thread.version}`,
        thread.sandboxProvider,
        thread.sandboxSize?.slice(0, 1) ?? "s",
      ].join(" ");
      items.push(
        { type: "separator" as const },
        { type: "label" as const, label: "Debug Only" },
        {
          type: "label" as const,
          label: debugStr,
        },
      );
      if (user?.role === "admin") {
        items.push({
          type: "button" as const,
          label: "View Debug Info",
          onSelect: async () => {
            window.open(`/internal/admin/thread/${thread.id}`, "_blank");
          },
        });
        if (thread.codesandboxId) {
          items.push({
            type: "button" as const,
            label: "View Agent Logs",
            onSelect: async () => {
              window.open(
                `/internal/admin/sandbox/${thread.sandboxProvider}/${thread.codesandboxId}`,
                "_blank",
              );
            },
          });
        }
      }
    }

    return items;
  }, [
    isDraft,
    showShareItem,
    thread,
    showPullRequestActions,
    showRedoTaskAction,
    redoDialogData,
    showReadUnreadActions,
    showRenameAction,
    isSmallScreen,
    onRenameClick,
    onShareClick,
    onTerminalClick,
    userFlags,
    user,
    archiveMutation,
    readMutation,
    unreadMutation,
    isReadOnly,
    isViewingThread,
    router,
    openPullRequestMutation,
  ]);

  return (
    <>
      <SheetOrMenu
        trigger={trigger}
        getItems={() => menuItems}
        onOpenChange={onMenuOpenChange}
        title="More"
        collapseAsDrawer
      />
      <TaskDeleteConfirmationModal
        open={showDeleteDialogState}
        onOpenChange={setShowDeleteDialogState}
        onConfirm={async () => {
          // Use mutateAsync to wait for the mutation to complete instead of onSuccess
          // because the component can unmount as a result of the mutation.
          await deleteMutation.mutateAsync(thread.id);
          if (isViewingThread()) {
            router.push("/dashboard");
          }
        }}
      />
      {showRedoTaskAction && redoDialogData && (
        <RedoTaskDialog
          threadId={redoDialogData.threadId}
          repoFullName={redoDialogData.repoFullName}
          repoBaseBranchName={redoDialogData.repoBaseBranchName}
          disableGitCheckpointing={redoDialogData.disableGitCheckpointing}
          skipSetup={redoDialogData.skipSetup}
          permissionMode={redoDialogData.permissionMode}
          initialUserMessage={redoDialogData.initialUserMessage}
          open={showRedoTaskDialog}
          onOpenChange={setShowRedoTaskDialog}
        />
      )}
    </>
  );
}
