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

export const ThreadListItem = memo(function ThreadListItem({
  thread,
  pathname,
  className,
  hideRepository,
}: {
  pathname: string;
  thread: ThreadInfo;
  className?: string;
  hideRepository: boolean;
}) {
  const title = useMemo(() => getThreadTitle(thread), [thread]);
  const isOptimisticThread = thread.id.startsWith("optimistic-");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const relativeTime = useMemo(
    () => formatRelativeTime(thread.updatedAt),
    [thread.updatedAt],
  );
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingDraft, setIsEditingDraft] = useState(false);

  return (
    <>
      <div
        className="relative group animate-in fade-in slide-in-from-top-1 duration-200"
        style={{ contentVisibility: "auto", containIntrinsicSize: "80px" }}
      >
        <Link
          href={`/task/${thread.id}`}
          prefetch={!isOptimisticThread}
          aria-disabled={isOptimisticThread}
          tabIndex={isOptimisticThread ? -1 : undefined}
          className={cn(
            "block rounded-[8px] transition-[background-color,border-color] duration-150 px-2.5 py-[7px] relative pr-9 border border-transparent",
            pathname === `/task/${thread.id}`
              ? "bg-primary/8 border-primary/15"
              : "hover:bg-accent/50",
            isMenuOpen && "bg-accent",
            isOptimisticThread && "opacity-80",
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
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
                <ThreadStatusIndicator thread={thread} />
              </div>
              {isEditingName ? (
                <InlineNameEditor
                  thread={thread}
                  onDone={() => setIsEditingName(false)}
                />
              ) : (
                <p
                  className="text-[13px] flex-1 truncate font-medium tracking-[-0.01em] leading-snug text-foreground"
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
                  {isOptimisticThread ? "Creating..." : relativeTime}
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
