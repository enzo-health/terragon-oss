"use client";

import Link from "next/link";
import { memo, useState, useRef, useEffect } from "react";
import { getThreadTitle } from "@/agent/thread-utils";
import { AIAgent } from "@terragon/agent/types";
import { DBUserMessage, ThreadInfoFull } from "@terragon/shared";
import type { ThreadMetaSnapshot } from "./meta-chips/use-thread-meta-events";
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
import { UsageChip } from "./meta-chips/usage-chip";
import { RateLimitChip } from "./meta-chips/rate-limit-chip";
import { ModelRoutingChip } from "./meta-chips/model-routing-chip";
import { McpServerHealthChip } from "./meta-chips/mcp-server-health-chip";

export const ChatHeader = memo(function ChatHeader({
  thread,
  threadAgent,
  redoDialogData,
  isReadOnly,
  onHeaderClick,
  onTerminalClick,
  metaSnapshot,
  githubSummary,
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
  metaSnapshot: ThreadMetaSnapshot;
  githubSummary: {
    prStatus: ThreadInfoFull["prStatus"];
    prChecksStatus: ThreadInfoFull["prChecksStatus"];
    githubPRNumber: ThreadInfoFull["githubPRNumber"];
    githubRepoFullName: ThreadInfoFull["githubRepoFullName"];
  };
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
        role={isMobile ? "button" : undefined}
        tabIndex={isMobile && onHeaderClick ? 0 : undefined}
        aria-label={isMobile ? "Open task details" : undefined}
        className={`relative z-10 flex min-h-14 w-full items-center justify-between gap-4 overflow-hidden px-[var(--space-fluid-edge)] ${headerClassName} ${headerSurfaceClassName}`}
        onClick={isMobile ? onHeaderClick : undefined}
        onKeyDown={
          isMobile && onHeaderClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onHeaderClick();
                }
              }
            : undefined
        }
        style={isMobile ? { cursor: "pointer" } : undefined}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isMobile && <SidebarTrigger className="px-0 size-auto w-fit" />}
          {canCollapseThreadList && isThreadListCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setThreadListCollapsed(false)}
              className="w-fit flex-shrink-0"
              title="Show task list"
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          )}
          <div className="flex min-w-0 w-full flex-col gap-1.5">
            <div className="flex w-full min-w-0 items-center gap-2">
              <div className="flex items-center opacity-80 flex-shrink-0">
                <ThreadStatusIndicator thread={thread} />
              </div>
              {isEditing ? (
                <Input
                  ref={inputRef}
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  onBlur={handleSave}
                  onKeyDown={handleKeyDown}
                  aria-label="Edit task name"
                  className="h-auto w-full rounded-sm border-0 bg-transparent px-0 py-0 text-[length:var(--text-fluid-title)] font-sans font-semibold tracking-[-0.01em] focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={getThreadTitle(thread)}
                  style={{ minWidth: "150px" }}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              ) : (
                <span className="truncate font-sans text-[length:var(--text-fluid-title)] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                  {getThreadTitle(thread)}
                </span>
              )}
              <div className="hidden items-center gap-2 flex-shrink-0 @xl/pane:flex">
                <div className="flex items-center opacity-70">
                  <ThreadAgentIcon thread={thread} />
                </div>
                {githubSummary.githubPRNumber && githubSummary.prStatus && (
                  <PRStatusPill
                    checksStatus={githubSummary.prChecksStatus}
                    status={githubSummary.prStatus}
                    prNumber={githubSummary.githubPRNumber}
                    repoFullName={githubSummary.githubRepoFullName}
                  />
                )}
              </div>
            </div>
            {/* metadata */}
            <div className="flex min-h-6 min-w-0 items-center gap-2 pl-[22px] text-[12px] text-muted-foreground md:text-[13px]">
              <span className="truncate font-medium text-foreground/80 @xl/pane:flex-shrink-0 @xl/pane:whitespace-nowrap">
                {thread.githubRepoFullName}
              </span>
              {githubSummary.githubPRNumber && githubSummary.prStatus && (
                <span className="flex-shrink-0 @xl/pane:hidden">
                  <PRStatusPill
                    checksStatus={githubSummary.prChecksStatus}
                    status={githubSummary.prStatus}
                    prNumber={githubSummary.githubPRNumber}
                    repoFullName={githubSummary.githubRepoFullName}
                  />
                </span>
              )}
              {thread.branchName && thread.repoBaseBranchName && (
                <span className="hidden min-w-0 items-center gap-1.5 overflow-hidden @xl/pane:inline-flex">
                  <a
                    href={`https://github.com/${thread.githubRepoFullName}/tree/${thread.repoBaseBranchName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block max-w-[200px] truncate rounded-full bg-muted/80 px-2 py-0.5 transition-[background-color,color] duration-[var(--duration-quick)] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    title={thread.repoBaseBranchName}
                  >
                    {thread.repoBaseBranchName}
                  </a>
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0 text-muted-foreground/80"
                  >
                    →
                  </span>
                  <a
                    href={`https://github.com/${thread.githubRepoFullName}/tree/${thread.branchName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block min-w-[35px] truncate rounded-full bg-muted/80 px-2 py-0.5 transition-[background-color,color] duration-[var(--duration-quick)] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    title={thread.branchName}
                  >
                    {thread.branchName}
                  </a>
                  <button
                    type="button"
                    className="ml-0.5 inline-flex cursor-pointer items-center rounded-full p-1 transition-[background-color,color] duration-[var(--duration-quick)] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
              <span className="hidden flex-shrink-0 items-center gap-1.5 @xl/pane:flex">
                <UsageChip tokenUsage={metaSnapshot.tokenUsage} />
                <RateLimitChip rateLimits={metaSnapshot.rateLimits} />
                <ModelRoutingChip modelReroute={metaSnapshot.modelReroute} />
                <McpServerHealthChip
                  mcpServerStatus={metaSnapshot.mcpServerStatus}
                />
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
        <div className="flex w-full items-center overflow-hidden border-b border-hairline bg-surface-soft px-4 py-2.5">
          {(isMobile || isThreadListCollapsed) && (
            <div
              className="px-0 size-auto w-fit block"
              style={{ width: "32px" }}
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex items-center gap-2">
              <Split className="h-3 w-3 text-muted-foreground shrink-0" />
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
        <div className="flex w-full items-center overflow-hidden border-b border-hairline bg-surface-soft px-4 py-2.5">
          {(isMobile || isThreadListCollapsed) && (
            <div
              className="px-0 size-auto w-fit block"
              style={{ width: "32px" }}
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex items-center gap-2">
              <Eye className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs font-mono font-medium whitespace-nowrap">
                View only
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                · Viewing someone else’s task
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
