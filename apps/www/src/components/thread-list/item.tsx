import Link from "next/link";
import { ThreadInfo, GitDiffStats } from "@terragon/shared";
import React, {
  memo,
  useMemo,
  useState,
  useRef,
  useEffect,
  useCallback,
} from "react";
import { getThreadTitle } from "@/agent/thread-utils";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { ThreadStatusIndicator } from "../thread-status";
import { ThreadMenuDropdown } from "../thread-menu-dropdown";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { WorkflowIcon, EllipsisVerticalIcon, GitBranch } from "lucide-react";
import { Input } from "../ui/input";
import { useUpdateThreadNameMutation } from "@/queries/thread-mutations";
import { DraftTaskDialog } from "../chat/draft-task-dialog";
import { ThreadAgentIcon } from "../thread-agent-icon";
import { toast } from "sonner";
import { prefetchThreadIntoCollections } from "@/collections/prefetch";
import { useAtomValue, useSetAtom } from "jotai";
import {
  threadSelectionAtom,
  enterSelectionModeAtom,
  toggleThreadSelectionAtom,
} from "@/atoms/user-cookies";

/**
 * Inline name editor: only mounted when the user clicks "Rename".
 * This keeps useUpdateThreadNameMutation out of the default render path,
 * avoiding a TanStack Query mutation observer per list item.
 */
const InlineNameEditor = memo(function InlineNameEditor({
  thread,
  onDone,
}: {
  thread: ThreadInfo;
  onDone: () => void;
}) {
  const [editedName, setEditedName] = useState(thread.name || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const updateNameMutation = useUpdateThreadNameMutation();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSave = () => {
    const trimmedName = editedName.trim();
    if (!trimmedName || trimmedName === thread.name) {
      onDone();
      return;
    }
    updateNameMutation.mutate(
      { threadId: thread.id, name: trimmedName },
      {
        onSuccess: () => onDone(),
        onError: () => toast.error("Failed to rename task"),
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  };

  return (
    <Input
      ref={inputRef}
      value={editedName}
      onChange={(e) => setEditedName(e.target.value)}
      onBlur={handleSave}
      onKeyDown={handleKeyDown}
      aria-label="Task name"
      className="h-auto py-0 px-1 text-[15px] font-medium border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-ring rounded-sm flex-1 min-w-0"
      placeholder={getThreadTitle(thread)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
      }}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
    />
  );
});

/**
 * Lazy menu trigger: renders just the icon button initially.
 * The full ThreadMenuDropdown (with its 4 mutation hooks) only mounts
 * on pointer interaction, saving ~400 mutation observers for a 100-item list.
 */
const LazyThreadListMenu = memo(function LazyThreadListMenu({
  thread,
  onRenameClick,
  onMenuOpenChange,
}: {
  thread: ThreadInfo;
  onRenameClick: () => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const [activated, setActivated] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pendingClick, setPendingClick] = useState(false);

  // After mounting the real dropdown, simulate a click to open it (fixes 2-tap issue on touch)
  useEffect(() => {
    if (activated && pendingClick && triggerRef.current) {
      triggerRef.current.click();
      setPendingClick(false);
    }
  }, [activated, pendingClick]);

  const menuTrigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      size="icon"
      aria-label="Thread options"
      className="w-fit px-1 hover:bg-transparent cursor-pointer"
    >
      <EllipsisVerticalIcon className="size-4 text-muted-foreground hover:text-foreground transition-colors" />
    </Button>
  );

  if (!activated) {
    return (
      <div
        onPointerEnter={() => setActivated(true)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setActivated(true);
          setPendingClick(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActivated(true);
            setPendingClick(true);
          }
        }}
      >
        {menuTrigger}
      </div>
    );
  }

  return (
    <ThreadMenuDropdown
      thread={thread}
      trigger={menuTrigger}
      showReadUnreadActions
      showRenameAction
      onRenameClick={onRenameClick}
      onMenuOpenChange={onMenuOpenChange}
    />
  );
});

const CreatingIndicator = memo(function CreatingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-primary">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/40 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary/60" />
      </span>
      <span className="text-micro font-medium tracking-wide uppercase">
        Creating
      </span>
    </span>
  );
});

/**
 * Branch glyph with the thread status riding as a corner badge — the
 * Superconductor-style leading icon. The badge's circular `bg-background` masks
 * the branch strokes behind the status mark so it reads as a distinct pip.
 */
const ThreadBranchIcon = memo(function ThreadBranchIcon({
  thread,
  isOptimistic,
}: {
  thread: ThreadInfo;
  isOptimistic: boolean;
}) {
  return (
    <div className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center">
      <GitBranch strokeWidth={2} className="size-4 text-muted-foreground/70" />
      <span className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-background">
        <ThreadStatusIndicator
          thread={thread}
          isOptimistic={isOptimistic}
          size="sm"
        />
      </span>
    </div>
  );
});

/** Right-aligned `+adds -dels` change counter. Hidden when there is no diff. */
const DiffStat = memo(function DiffStat({ stats }: { stats: GitDiffStats }) {
  if (stats.additions === 0 && stats.deletions === 0) return null;
  return (
    <span className="flex flex-shrink-0 items-center gap-1.5 text-micro font-medium tabular-nums">
      <span className="text-success">+{stats.additions}</span>
      <span className="text-error">-{stats.deletions}</span>
    </span>
  );
});

/** Tailwind text color for the inline `#PR` ref, keyed off CI checks status so
 * the subtitle keeps the pass/fail/pending signal the old pill carried. */
function prChecksColorClass(thread: ThreadInfo): string {
  switch (thread.prChecksStatus) {
    case "success":
      return "text-success";
    case "failure":
      return "text-error";
    case "pending":
      return "text-warning";
    default:
      return "";
  }
}

/**
 * Global registry to track recently reconciled thread titles
 * Used to detect when a real thread replaces an optimistic one
 */
const recentlyReconciledTitles = new Set<string>();
let reconciliationTimeout: NodeJS.Timeout | null = null;

export function markThreadAsReconciled(title: string) {
  recentlyReconciledTitles.add(title);

  // Clear the registry after a short delay
  if (reconciliationTimeout) {
    clearTimeout(reconciliationTimeout);
  }
  reconciliationTimeout = setTimeout(() => {
    recentlyReconciledTitles.clear();
  }, 500);
}

/**
 * Hook to track if thread was recently reconciled (optimistic -> real)
 * Used to trigger smooth transition animation
 */
function useReconciliationAnimation(
  threadId: string,
  isOptimistic: boolean,
  title: string,
) {
  const [isReconciling, setIsReconciling] = useState(false);
  const prevOptimisticRef = useRef(isOptimistic);
  const hasCheckedMountRef = useRef(false);

  // Check on mount if this real thread was just reconciled
  useEffect(() => {
    if (!hasCheckedMountRef.current && !isOptimistic) {
      hasCheckedMountRef.current = true;

      // Check if a thread with this title was recently marked as reconciled
      if (recentlyReconciledTitles.has(title)) {
        setIsReconciling(true);
        const timer = setTimeout(() => setIsReconciling(false), 400);
        return () => clearTimeout(timer);
      }
    }
  }, [isOptimistic, title]);

  // Track when optimistic thread disappears
  useEffect(() => {
    const wasOptimistic = prevOptimisticRef.current;

    if (wasOptimistic && !isOptimistic) {
      // This optimistic thread is being replaced - mark it
      markThreadAsReconciled(title);
    }

    prevOptimisticRef.current = isOptimistic;
  }, [isOptimistic, title]);

  return isReconciling;
}

export const ThreadListItem = memo(function ThreadListItem({
  thread,
  pathname,
  className,
  hideRepository,
  style,
  allThreadIds,
}: {
  pathname: string;
  thread: ThreadInfo;
  className?: string;
  hideRepository: boolean;
  style?: React.CSSProperties;
  allThreadIds?: string[];
}) {
  const title = useMemo(() => getThreadTitle(thread), [thread]);
  const relativeTime = useMemo(
    () => formatRelativeTime(thread.updatedAt),
    [thread.updatedAt],
  );
  const isOptimisticThread = thread.id.startsWith("optimistic-");
  const isReconciling = useReconciliationAnimation(
    thread.id,
    isOptimisticThread,
    title,
  );
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingDraft, setIsEditingDraft] = useState(false);

  // Selection state
  const selection = useAtomValue(threadSelectionAtom);
  const enterSelectionMode = useSetAtom(enterSelectionModeAtom);
  const toggleThreadSelection = useSetAtom(toggleThreadSelectionAtom);

  const isSelected = selection.selectedIds.has(thread.id);
  const isSelectionMode = selection.isSelectionMode;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isOptimisticThread) {
        e.preventDefault();
        return;
      }

      // Handle selection mode interactions
      if (isSelectionMode) {
        e.preventDefault();
        e.stopPropagation();

        const isRangeSelect = e.shiftKey && selection.lastSelectedId;
        const threadIds = allThreadIds || [];
        toggleThreadSelection({
          threadId: thread.id,
          range: isRangeSelect ? threadIds : undefined,
        });
        return;
      }

      // Enter selection mode on Ctrl/Cmd+click
      if ((e.ctrlKey || e.metaKey) && !isOptimisticThread) {
        e.preventDefault();
        e.stopPropagation();
        enterSelectionMode(thread.id);
        return;
      }

      if (!e.defaultPrevented && thread.draftMessage) {
        e.preventDefault();
        setIsEditingDraft(true);
      }
    },
    [
      isOptimisticThread,
      isSelectionMode,
      selection.lastSelectedId,
      thread.id,
      thread.draftMessage,
      allThreadIds,
      toggleThreadSelection,
      enterSelectionMode,
    ],
  );

  const handleCheckboxChange = useCallback(
    (checked: boolean) => {
      const isRangeSelect =
        (window as typeof window & { lastClickHadShift?: boolean })
          .lastClickHadShift && selection.lastSelectedId;
      const threadIds = allThreadIds || [];

      toggleThreadSelection({
        threadId: thread.id,
        range: isRangeSelect ? threadIds : undefined,
      });
    },
    [thread.id, allThreadIds, selection.lastSelectedId, toggleThreadSelection],
  );

  return (
    <>
      <div
        className={cn(
          "relative group",
          "animate-in fade-in slide-in-from-top-2 duration-300 ease-out",
          isReconciling && "reconciliation-flash",
          isSelected && "ring-2 ring-primary/30 rounded-md",
        )}
        style={{
          contentVisibility: "auto",
          containIntrinsicSize: "80px",
          ...style,
        }}
      >
        <Link
          href={`/task/${thread.id}`}
          prefetch={!isOptimisticThread && !isSelectionMode}
          aria-disabled={isOptimisticThread}
          tabIndex={isOptimisticThread ? -1 : undefined}
          className={cn(
            "block rounded-md transition-[background-color,border-color,box-shadow] duration-200 ease-out px-2 py-1 relative pr-8 border focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            pathname === `/task/${thread.id}` && !isSelectionMode
              ? "bg-primary/[0.06] border-transparent before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-primary before:content-['']"
              : "hover:bg-accent/60 border-transparent",
            isMenuOpen && "bg-accent",
            isOptimisticThread && [
              "bg-primary/[0.03] border-primary/15",
              "relative overflow-hidden",
              "cursor-default",
            ],
            isSelectionMode && "cursor-pointer hover:bg-accent",
            isSelected && "bg-primary/[0.05]",
            className,
          )}
          onMouseEnter={() => {
            if (!isOptimisticThread && !isSelectionMode) {
              prefetchThreadIntoCollections(thread.id);
            }
          }}
          onClick={handleClick}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!isOptimisticThread && !isSelectionMode) {
              enterSelectionMode(thread.id);
            }
          }}
        >
          {/* Subtle progress bar for optimistic threads */}
          {isOptimisticThread && (
            <div className="absolute bottom-0 left-2 right-2 h-[1.5px] bg-primary/10 rounded-full overflow-hidden">
              <div className="h-full bg-primary/50 animate-progress-indeterminate rounded-full" />
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              {/* Selection checkbox */}
              {isSelectionMode && !isOptimisticThread && (
                <div
                  className="flex-shrink-0 w-4 h-4"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={handleCheckboxChange}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  />
                </div>
              )}
              {/* Branch glyph + status badge (hidden in selection mode) */}
              {(!isSelectionMode || isOptimisticThread) && (
                <ThreadBranchIcon
                  thread={thread}
                  isOptimistic={isOptimisticThread}
                />
              )}
              {isEditingName ? (
                <InlineNameEditor
                  thread={thread}
                  onDone={() => setIsEditingName(false)}
                />
              ) : (
                <p
                  className={cn(
                    "text-[13px] flex-1 truncate font-medium leading-snug",
                    isOptimisticThread
                      ? "text-muted-foreground"
                      : "text-foreground",
                  )}
                  title={title}
                >
                  {thread.branchName || title}
                </p>
              )}
              {!isEditingName && thread.gitDiffStats && (
                <DiffStat stats={thread.gitDiffStats} />
              )}
            </div>
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-1.5 text-micro text-muted-foreground min-w-0">
                {thread.githubPRNumber && (
                  <>
                    <button
                      type="button"
                      className={cn(
                        "flex-shrink-0 tabular-nums hover:underline",
                        prChecksColorClass(thread),
                      )}
                      title="View pull request"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(
                          `https://github.com/${thread.githubRepoFullName}/pull/${thread.githubPRNumber}`,
                          "_blank",
                        );
                      }}
                    >
                      #{thread.githubPRNumber}
                    </button>
                    <span className="flex-shrink-0 opacity-50">·</span>
                  </>
                )}
                <span
                  className="flex-shrink-0"
                  title={new Date(thread.updatedAt).toLocaleString()}
                >
                  {isOptimisticThread ? <CreatingIndicator /> : relativeTime}
                </span>
                {thread.githubRepoFullName && !hideRepository && (
                  <>
                    <span className="flex-shrink-0 opacity-50">·</span>
                    <span
                      className="truncate"
                      title={thread.githubRepoFullName}
                    >
                      {thread.githubRepoFullName}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {thread.automationId && (
                  <SmallAutomationIndicator
                    automationId={thread.automationId}
                  />
                )}
                <div
                  className="text-muted-foreground"
                  title={
                    thread.threadChats[0]?.agent
                      ? `Agent: ${thread.threadChats[0].agent}`
                      : undefined
                  }
                  aria-label={
                    thread.threadChats[0]?.agent
                      ? `Agent: ${thread.threadChats[0].agent}`
                      : "Agent"
                  }
                >
                  <ThreadAgentIcon thread={thread} />
                </div>
              </div>
            </div>
          </div>
        </Link>
        {/* Menu button - hidden in selection mode */}
        {!isSelectionMode && (
          <div
            className={cn(
              "absolute right-0 top-1/2 -translate-y-1/2 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
              isMenuOpen
                ? "opacity-100"
                : "opacity-100 sm:opacity-0 focus-within:opacity-100",
              isOptimisticThread && "pointer-events-none opacity-0",
            )}
            onClick={(e) => {
              e.preventDefault();
            }}
          >
            <LazyThreadListMenu
              thread={thread}
              onRenameClick={() => setIsEditingName(true)}
              onMenuOpenChange={setIsMenuOpen}
            />
          </div>
        )}
      </div>
      {thread.draftMessage && (
        <DraftTaskDialog
          thread={thread}
          open={isEditingDraft}
          onOpenChange={setIsEditingDraft}
        />
      )}
    </>
  );
});

function SmallAutomationIndicator({ automationId }: { automationId: string }) {
  return (
    <Link
      href={`/automations/${automationId}`}
      prefetch={true}
      onClick={(e) => e.stopPropagation()}
      className="cursor-pointer"
      title="Automation"
    >
      <WorkflowIcon className="size-4 text-muted-foreground" />
    </Link>
  );
}
