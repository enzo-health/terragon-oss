import Link from "next/link";
import { ThreadInfo } from "@terragon/shared";
import React, { memo, useMemo, useState, useRef, useEffect } from "react";
import { getThreadTitle } from "@/agent/thread-utils";
import { PRStatusPill } from "../pr-status-pill";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { ThreadStatusIndicator } from "../thread-status";
import { ThreadMenuDropdown } from "../thread-menu-dropdown";
import { Button } from "../ui/button";
import { WorkflowIcon, EllipsisVerticalIcon } from "lucide-react";
import { Input } from "../ui/input";
import { useUpdateThreadNameMutation } from "@/queries/thread-mutations";
import { DraftTaskDialog } from "../chat/draft-task-dialog";
import { ThreadAgentIcon } from "../thread-agent-icon";
import { toast } from "sonner";
import { prefetchThreadIntoCollections } from "@/collections/prefetch";

/**
 * Inline name editor — only mounted when the user clicks "Rename".
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
 * Lazy menu trigger — renders just the icon button initially.
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

/**
 * Animated loading indicator for optimistic threads
 * Designed with Linear/Vercel-inspired minimalism
 */
const CreatingIndicator = memo(function CreatingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-primary/60">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/40 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary/60" />
      </span>
      <span className="text-[11px] font-medium tracking-wide uppercase">
        Creating
      </span>
    </span>
  );
});

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
  relativeTimeTick: _relativeTimeTick,
  className,
  hideRepository,
  style,
}: {
  pathname: string;
  thread: ThreadInfo;
  relativeTimeTick: number;
  className?: string;
  hideRepository: boolean;
  style?: React.CSSProperties;
}) {
  const title = useMemo(() => getThreadTitle(thread), [thread]);
  const isOptimisticThread = thread.id.startsWith("optimistic-");
  const isReconciling = useReconciliationAnimation(
    thread.id,
    isOptimisticThread,
    title,
  );
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const relativeTime = formatRelativeTime(thread.updatedAt);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingDraft, setIsEditingDraft] = useState(false);

  return (
    <>
      <div
        className={cn(
          "relative group",
          "animate-in fade-in slide-in-from-top-2 duration-300 ease-out",
          isReconciling && "reconciliation-flash",
        )}
        style={{
          contentVisibility: "auto",
          containIntrinsicSize: "80px",
          ...style,
        }}
      >
        <Link
          href={`/task/${thread.id}`}
          prefetch={!isOptimisticThread}
          aria-disabled={isOptimisticThread}
          tabIndex={isOptimisticThread ? -1 : undefined}
          className={cn(
            "block rounded-lg transition-all duration-200 ease-out px-2.5 py-[7px] relative pr-9 border",
            pathname === `/task/${thread.id}`
              ? "bg-primary/[0.06] border-primary/20"
              : "hover:bg-accent/60 border-transparent",
            isMenuOpen && "bg-accent",
            isOptimisticThread && [
              "bg-primary/[0.03] border-primary/15",
              "relative overflow-hidden",
              "cursor-default",
            ],
            className,
          )}
          onMouseEnter={() => {
            if (!isOptimisticThread) {
              prefetchThreadIntoCollections(thread.id);
            }
          }}
          onClick={(e) => {
            if (isOptimisticThread) {
              e.preventDefault();
              return;
            }
            if (!e.defaultPrevented && thread.draftMessage) {
              e.preventDefault();
              setIsEditingDraft(true);
            }
          }}
        >
          {/* Subtle progress bar for optimistic threads */}
          {isOptimisticThread && (
            <div className="absolute bottom-0 left-2 right-2 h-[1.5px] bg-primary/10 rounded-full overflow-hidden">
              <div className="h-full bg-primary/50 animate-progress-indeterminate rounded-full" />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
                <ThreadStatusIndicator
                  thread={thread}
                  isOptimistic={isOptimisticThread}
                />
              </div>
              {isEditingName ? (
                <InlineNameEditor
                  thread={thread}
                  onDone={() => setIsEditingName(false)}
                />
              ) : (
                <p
                  className={cn(
                    "text-[13px] flex-1 truncate font-medium tracking-[-0.01em] leading-snug",
                    isOptimisticThread
                      ? "text-foreground/80"
                      : "text-foreground",
                  )}
                  title={title}
                >
                  {title}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80 min-w-0 font-sans tracking-normal">
                <span
                  className="flex-shrink-0"
                  title={new Date(thread.updatedAt).toLocaleString()}
                >
                  {isOptimisticThread ? <CreatingIndicator /> : relativeTime}
                </span>
                {thread.githubRepoFullName && !hideRepository && (
                  <>
                    <span className="flex-shrink-0 opacity-60">·</span>
                    <span
                      className="truncate opacity-80"
                      title={thread.githubRepoFullName}
                    >
                      {thread.githubRepoFullName}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {thread.automationId && (
                  <SmallAutomationIndicator
                    automationId={thread.automationId}
                  />
                )}
                {thread.githubPRNumber && thread.prStatus && (
                  <PRStatusPill
                    status={thread.prStatus}
                    checksStatus={thread.prChecksStatus}
                    prNumber={thread.githubPRNumber}
                    repoFullName={thread.githubRepoFullName}
                  />
                )}
                <div className="opacity-80 scale-90">
                  <ThreadAgentIcon thread={thread} />
                </div>
              </div>
            </div>
          </div>
        </Link>
        <div
          className={cn(
            "absolute right-0 top-1/2 -translate-y-1/2 transition-opacity group-hover:opacity-100",
            isMenuOpen ? "opacity-100" : "opacity-100 sm:opacity-0",
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
