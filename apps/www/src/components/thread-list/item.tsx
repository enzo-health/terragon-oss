import Link from "next/link";
import { ThreadInfo } from "@terragon/shared";
import { memo, useMemo, useState, useRef, useEffect } from "react";
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const relativeTime = useMemo(
    () => formatRelativeTime(thread.updatedAt),
    [thread.updatedAt],
  );
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(thread.name || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [isEditingDraft, setIsEditingDraft] = useState(false);
  const updateNameMutation = useUpdateThreadNameMutation();

  useEffect(() => {
    if (isEditingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingName]);

  const handleSave = () => {
    const trimmedName = editedName.trim();
    if (!trimmedName || trimmedName === thread.name) {
      setIsEditingName(false);
      setEditedName(thread.name || "");
      return;
    }
    updateNameMutation.mutate(
      {
        threadId: thread.id,
        name: trimmedName,
      },
      {
        onSuccess: () => {
          setIsEditingName(false);
        },
        onError: () => {
          setEditedName(thread.name || "");
        },
      },
    );
  };

  const handleCancel = () => {
    setIsEditingName(false);
    setEditedName(thread.name || "");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <>
      <div className="relative group animate-in fade-in slide-in-from-top-1 duration-200">
        <Link
          href={`/task/${thread.id}`}
          className={cn(
            "block rounded-md transition-colors p-2 relative pr-8",
            pathname === `/task/${thread.id}`
              ? "bg-muted"
              : "hover:bg-muted/50",
            isMenuOpen && "bg-muted/50",
            className,
          )}
          onClick={(e) => {
            if (!e.defaultPrevented && thread.draftMessage) {
              e.preventDefault();
              setIsEditingDraft(true);
            }
          }}
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 flex-shrink-0 flex items-center justify-center">
                <ThreadStatusIndicator thread={thread} />
              </div>
              {isEditingName ? (
                <Input
                  ref={inputRef}
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  onBlur={handleSave}
                  onKeyDown={handleKeyDown}
                  className="h-auto py-0 px-1 text-sm font-medium border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-ring rounded-sm flex-1 min-w-0"
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
              ) : (
                <p
                  className="text-sm flex-1 truncate font-medium"
                  title={title}
                >
                  {title}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                <span
                  className="flex-shrink-0"
                  title={new Date(thread.updatedAt).toLocaleString()}
                >
                  {relativeTime}
                </span>
                {thread.githubRepoFullName && !hideRepository && (
                  <>
                    <span className="flex-shrink-0">·</span>
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
                {thread.githubPRNumber && thread.prStatus && (
                  <PRStatusPill
                    status={thread.prStatus}
                    checksStatus={thread.prChecksStatus}
                    prNumber={thread.githubPRNumber}
                    repoFullName={thread.githubRepoFullName}
                  />
                )}
                <ThreadAgentIcon thread={thread} />
              </div>
            </div>
          </div>
        </Link>
        <div
          className={cn(
            "absolute right-0 top-1/2 -translate-y-1/2 transition-opacity group-hover:opacity-100",
            isMenuOpen ? "opacity-100" : "opacity-100 sm:opacity-0",
          )}
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          <ThreadMenuDropdown
            thread={thread}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="w-fit px-1 hover:bg-transparent cursor-pointer"
              >
                <EllipsisVerticalIcon className="size-4 text-muted-foreground hover:text-foreground transition-colors" />
              </Button>
            }
            showReadUnreadActions
            showRenameAction
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
      onClick={(e) => e.stopPropagation()}
      className="cursor-pointer"
      title="Automation"
    >
      <WorkflowIcon className="size-4 text-muted-foreground" />
    </Link>
  );
}
