"use client";

import Link from "next/link";
import { memo, useState, useRef, useEffect } from "react";
import { getThreadTitle } from "@/agent/thread-utils";
import { AIAgent } from "@terragon/agent/types";
import { DBUserMessage, ThreadInfoFull } from "@terragon/shared";
import { PRStatusPill } from "../pr-status-pill";
import { toast } from "sonner";
import { Pill } from "@/components/shared/pill";
import { ChatHeaderButtons } from "./chat-header-buttons";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { ThreadStatusIndicator } from "@/components/thread-status";
import { Input } from "@/components/ui/input";
import { useUpdateThreadNameMutation } from "@/queries/thread-mutations";
import { AutomationPill } from "@/components/automations/pill";
import { Eye, CloudOff, PanelRightClose, Split, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCollapsibleThreadList } from "../thread-list/use-collapsible-thread-list";
import { ThreadAgentIcon } from "../thread-agent-icon";
import { headerClassName, headerSurfaceClassName } from "../shared/header";

export const ChatHeader = memo(function ChatHeader({
  thread,
  threadAgent,
  redoDialogData,
  isReadOnly,
  onHeaderClick,
  onTerminalClick,
}: {
  thread: ThreadInfoFull;
  threadAgent: AIAgent;
  redoDialogData?: {
    threadId: string;
    repoFullName: string;
    repoBaseBranchName: string;
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    permissionMode: "allowAll" | "plan";
    initialUserMessage: DBUserMessage;
  };
  isReadOnly: boolean;
  onHeaderClick?: () => void;
  onTerminalClick?: () => void;
}) {
  const { isMobile } = useSidebar();
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(thread.name || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const updateNameMutation = useUpdateThreadNameMutation();
  const {
    canCollapseThreadList,
    isThreadListCollapsed,
    setThreadListCollapsed,
  } = useCollapsibleThreadList();
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmedName = editedName.trim();
    // Don't submit if name is empty or unchanged
    if (!trimmedName || trimmedName === thread.name) {
      setIsEditing(false);
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
          setIsEditing(false);
        },
        onError: () => {
          setEditedName(thread.name || "");
        },
      },
    );
  };

  const handleCancel = () => {
    setIsEditing(false);
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
      <div
        className={`relative z-10 flex w-full items-center justify-between gap-4 overflow-hidden px-4 md:px-6 ${headerClassName} ${headerSurfaceClassName}`}
        onClick={isMobile ? onHeaderClick : undefined}
        style={isMobile ? { cursor: "pointer" } : undefined}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isMobile && <SidebarTrigger className="px-0 size-auto w-fit mr-2" />}
          {canCollapseThreadList && isThreadListCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setThreadListCollapsed(false)}
              className="w-fit mr-2 flex-shrink-0"
              title="Show task list"
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          )}
          <div className="flex flex-col min-w-0 w-full gap-0.5">
            <div className="flex items-center gap-3 w-full">
              <div className="opacity-80">
                <ThreadStatusIndicator thread={thread} />
              </div>
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                {isEditing ? (
                  <Input
                    ref={inputRef}
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    onBlur={handleSave}
                    onKeyDown={handleKeyDown}
                    className="h-auto w-full rounded-sm border-0 bg-transparent px-0 py-0 text-[15px] font-display font-medium tracking-[-0.02em] focus-visible:ring-1 focus-visible:ring-ring md:text-[17px]"
                    placeholder={getThreadTitle(thread)}
                    style={{ minWidth: "150px" }}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                ) : (
                  <span className="truncate font-display text-[15px] font-medium leading-tight tracking-[-0.02em] text-foreground md:text-[17px]">
                    {getThreadTitle(thread)}
                  </span>
                )}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="opacity-70">
                    <ThreadAgentIcon thread={thread} />
                  </div>
                  {thread.githubPRNumber && thread.prStatus && (
                    <PRStatusPill
                      checksStatus={thread.prChecksStatus}
                      status={thread.prStatus}
                      prNumber={thread.githubPRNumber}
                      repoFullName={thread.githubRepoFullName}
                    />
                  )}
                </div>
              </div>
            </div>
            {/* metadata */}
            <div className="flex h-5 min-w-0 items-center gap-2 text-[12px] tracking-[0.12px] text-muted-foreground/75 md:text-[13px]">
              <span className="flex-shrink-0 whitespace-nowrap font-medium text-foreground/65">
                {thread.githubRepoFullName}
              </span>
              {thread.branchName && thread.repoBaseBranchName && (
                <span className="hidden min-w-0 items-center gap-1.5 overflow-hidden sm:inline-flex">
                  <a
                    href={`https://github.com/${thread.githubRepoFullName}/tree/${thread.repoBaseBranchName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block max-w-[200px] truncate rounded-full bg-muted/80 px-2 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                    title={thread.repoBaseBranchName}
                  >
                    {thread.repoBaseBranchName}
                  </a>
                  <span className="flex-shrink-0 text-muted-foreground/55">
                    →
                  </span>
                  <a
                    href={`https://github.com/${thread.githubRepoFullName}/tree/${thread.branchName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block min-w-[35px] truncate rounded-full bg-muted/80 px-2 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                    title={thread.branchName}
                  >
                    {thread.branchName}
                  </a>
                  <button
                    type="button"
                    className="ml-0.5 inline-flex cursor-pointer items-center rounded-full p-1 transition-colors hover:bg-muted hover:text-foreground"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      try {
                        navigator.clipboard.writeText(thread.branchName!);
                        toast.success("Copied branch name");
                      } catch (err) {
                        console.error("Failed to copy branch name", err);
                      }
                    }}
                    title="Copy branch name"
                    aria-label="Copy branch name"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </span>
              )}
              {thread.disableGitCheckpointing && (
                <span
                  className="inline-flex items-center ml-1 align-middle"
                  title="Git checkpointing disabled"
                >
                  <CloudOff className="h-3 w-3 opacity-60" />
                </span>
              )}
              <span className="flex items-center gap-2">
                {thread.automationId && (
                  <AutomationPill
                    automationId={thread.automationId}
                    isReadOnly={isReadOnly}
                  />
                )}
                {thread.archived && <Pill label="Archived" />}
              </span>
            </div>
          </div>
        </div>
        <ChatHeaderButtons
          thread={thread}
          threadAgent={threadAgent}
          redoDialogData={redoDialogData}
          onRenameClick={() => setIsEditing(true)}
          isReadOnly={isReadOnly}
          onTerminalClick={onTerminalClick}
        />
      </div>
      {thread.sourceType === "www-fork" && (
        <div className="flex w-full items-center overflow-hidden border-b border-border/70 bg-muted/55 px-4 py-2.5">
          {(isMobile || isThreadListCollapsed) && (
            <div
              className="px-0 size-auto w-fit block"
              style={{ width: "32px" }}
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex items-center gap-2">
              <Split className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-mono font-medium line-clamp-1">
                Forked from{" "}
                <Link
                  href={`/task/${thread.parentThreadId}`}
                  className="underline"
                >
                  {thread.parentThreadName ?? ""}
                </Link>
              </span>
            </div>
          </div>
        </div>
      )}
      {isReadOnly && (
        <div className="flex w-full items-center overflow-hidden border-b border-border/70 bg-muted/55 px-4 py-2.5">
          {(isMobile || isThreadListCollapsed) && (
            <div
              className="px-0 size-auto w-fit block"
              style={{ width: "32px" }}
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex items-center gap-2">
              <Eye className="h-2.5 w-2.5 text-muted-foreground" />
              <span className="text-xs font-mono font-medium whitespace-nowrap">
                View only
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                · Viewing someone else's task
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
