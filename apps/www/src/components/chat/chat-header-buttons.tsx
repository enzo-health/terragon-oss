"use client";

import { toast } from "sonner";
import { ThreadInfo, ThreadInfoFull, ThreadVisibility } from "@terragon/shared";
import { useCallback, useState, useEffect, memo } from "react";
import {
  Terminal,
  Copy,
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Lock,
  Link2,
  Users,
  Loader2,
  Globe,
  MoreHorizontal,
  MonitorPlay,
} from "lucide-react";
import { PanelRight, PanelBottom } from "@/components/icons/panels";
import { openPullRequest } from "@/server-actions/pull-request";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Checkbox } from "../ui/checkbox";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "../ui/drawer";
import { useUpdateThreadVisibilityMutation } from "@/queries/thread-mutations";
import { useIsSmallScreen } from "@/hooks/useMediaQuery";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { ThreadMenuDropdown } from "../thread-menu-dropdown";
import { publicDocsUrl } from "@terragon/env/next-public";
import { useAtomValue } from "jotai";
import { userSettingsAtom } from "@/atoms/user";
import posthog from "posthog-js";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { useThread } from "./thread-context";
import { useSecondaryPanel } from "./hooks";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

export const ChatHeaderButtons = memo(function ChatHeaderButtons({
  thread,
  onRenameClick,
  isReadOnly = false,
  onTerminalClick,
}: {
  thread: ThreadInfoFull;
  onRenameClick: () => void;
  isReadOnly?: boolean;
  onTerminalClick?: () => void;
}) {
  const isSmallScreen = useIsSmallScreen();
  const [shareDrawerOpen, setShareDrawerOpen] = useState(false);
  const {
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
    setSecondaryPanelMode,
  } = useSecondaryPanel();
  const isSandboxPreviewEnabled = useFeatureFlag("sandboxPreview");

  const handleShareClick = () => {
    setShareDrawerOpen(true);
  };
  const handleToggleSecondaryPanel = () => {
    const nextOpen = !isSecondaryPanelOpen;
    if (nextOpen) {
      setSecondaryPanelMode("diff");
    }
    setIsSecondaryPanelOpen(nextOpen);
  };
  const handleOpenPreviewPanel = () => {
    setSecondaryPanelMode("preview");
    setIsSecondaryPanelOpen(true);
  };

  return (
    <>
      <div className="flex gap-2 sm:gap-2.5 items-center">
        {(!isReadOnly || isSmallScreen) && (
          <ThreadMenuDropdown
            thread={thread}
            trigger={
              <Button variant="ghost" size="icon" aria-label="More options">
                <MoreHorizontal className="size-4" />
              </Button>
            }
            onRenameClick={onRenameClick}
            onShareClick={handleShareClick}
            onTerminalClick={onTerminalClick}
            showRedoTaskAction={!isReadOnly}
            showPullRequestActions
            showRenameAction={!isReadOnly}
            showShareAction={true}
            isReadOnly={isReadOnly}
          />
        )}
        {isSandboxPreviewEnabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenPreviewPanel}
            aria-label="Open preview panel"
            className="gap-2"
          >
            <MonitorPlay className="size-4" />
            <span className="hidden sm:inline">Preview</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleToggleSecondaryPanel}
          aria-label="Toggle secondary panel"
        >
          {isSmallScreen ? (
            <PanelBottom className="size-4" isOpen={isSecondaryPanelOpen} />
          ) : (
            <PanelRight className="size-4" isOpen={isSecondaryPanelOpen} />
          )}
        </Button>
        {!isReadOnly && !isSmallScreen && <CodeButton thread={thread} />}
        {/* Hide ShareButton on mobile */}
        {!isSmallScreen && (
          <ShareButton thread={thread} isReadOnly={isReadOnly} />
        )}
      </div>

      {/* Share Drawer for mobile */}
      <ShareDrawer
        thread={thread}
        open={shareDrawerOpen}
        onOpenChange={setShareDrawerOpen}
        isReadOnly={isReadOnly}
      />
    </>
  );
});

function CodeButton({ thread }: { thread: ThreadInfoFull }) {
  const { threadChat } = useThread();
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openClaude, setOpenClaude] = useState(false);
  // Check if this is a claude code agent
  const isClaudeCodeAgent = threadChat?.agent === "claudeCode";

  // Load the preference from localStorage on mount
  useEffect(() => {
    // Don't load preference for non claude code agents
    if (isClaudeCodeAgent) {
      const stored = localStorage.getItem("terry-open-claude");
      if (stored === "true") {
        setOpenClaude(true);
      }
    }
  }, [isClaudeCodeAgent]);

  // Save the preference to localStorage when it changes
  const handleOpenClaudeChange = (checked: boolean) => {
    setOpenClaude(checked);
    localStorage.setItem("terry-open-claude", String(checked));
  };

  const copyToClipboard = async (
    text: string,
    message: string,
    commandId: string,
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
      setCopiedCommand(commandId);
      setTimeout(() => setCopiedCommand(null), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
      toast.error("Failed to copy");
    }
  };

  const pullCommand = `terry pull${openClaude && isClaudeCodeAgent ? " -r" : ""} ${thread.id}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="default">
          <Terminal className="h-4 w-4" />
          <span className="hidden sm:inline">Code</span>
          <ChevronDown className="h-4 w-4 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex flex-col">
          {/* Header - matching Share modal style */}
          <div className="p-3 border-b">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Pull with Terry CLI</h4>
              <a
                href={`${publicDocsUrl()}/docs/integrations/cli`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline hover:text-foreground inline-flex items-center gap-1"
              >
                Install CLI
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>

          {/* Pull section */}
          <div className="p-3 border-b">
            <div
              className="flex items-center bg-muted rounded-md font-mono text-sm cursor-pointer hover:bg-muted/80 transition-colors"
              onClick={() => {
                copyToClipboard(pullCommand, "Copied pull command", "terry");
                posthog.capture("terry_pull_command_copied", {
                  threadId: thread.id,
                  agent: threadChat?.agent,
                  withResume: isClaudeCodeAgent && openClaude,
                  hasDiff: !!thread.gitDiff,
                });
              }}
            >
              <div className="flex-1 overflow-x-auto p-2 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full">
                <code className="text-xs whitespace-nowrap">{pullCommand}</code>
              </div>
              <button
                className="h-7 w-7 p-0 mr-1 flex-shrink-0 flex items-center justify-center"
                aria-label="Copy command"
              >
                {copiedCommand === "terry" ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
            {isClaudeCodeAgent && (
              <div className="flex items-center space-x-2 mt-3">
                <Checkbox
                  id="open-claude"
                  checked={openClaude}
                  onCheckedChange={handleOpenClaudeChange}
                />
                <label
                  htmlFor="open-claude"
                  className="text-xs text-muted-foreground cursor-pointer select-none"
                >
                  Open Claude after pull
                </label>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-1">
            <ViewOrCreatePRButton
              thread={thread}
              closePopover={() => setOpen(false)}
            />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                if (!thread.gitDiff) {
                  toast.error("No changes to copy");
                  return;
                }
                const patchCommand = `git apply - <<'PATCH'\n${thread.gitDiff}\nPATCH`;
                copyToClipboard(patchCommand, "Copied patch command", "patch");
                posthog.capture("git_patch_copied", {
                  threadId: thread.id,
                  agent: threadChat?.agent,
                  hasDiff: !!thread.gitDiff,
                });
              }}
            >
              <Copy className="h-4 w-4 mr-2" />
              Copy Git Patch
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ViewOrCreatePRButton({
  thread,
  closePopover,
}: {
  thread: ThreadInfo;
  closePopover: () => void;
}) {
  const [isCreatingPR, setIsCreatingPR] = useState(false);
  const [isCreatingDraftPR, setIsCreatingDraftPR] = useState(false);
  const userSettings = useAtomValue(userSettingsAtom);
  const openPullRequestMutation = useServerActionMutation({
    mutationFn: openPullRequest,
  });

  // Use user's preference for PR type, default to draft if not set
  const preferredPrType = userSettings?.prType || "draft";

  const createPR = useCallback(
    async ({ draftPR }: { draftPR: boolean }) => {
      try {
        if (draftPR) {
          setIsCreatingDraftPR(true);
        } else {
          setIsCreatingPR(true);
        }
        await openPullRequestMutation.mutateAsync({
          threadId: thread.id,
          prType: draftPR ? "draft" : "ready",
        });
        closePopover();
      } catch (err) {
        console.error("Failed to create pull request", err);
      } finally {
        if (draftPR) {
          setIsCreatingDraftPR(false);
        } else {
          setIsCreatingPR(false);
        }
      }
    },
    [thread, closePopover, openPullRequestMutation],
  );

  if (thread.githubPRNumber) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => {
          const prUrl = `https://github.com/${thread.githubRepoFullName}/pull/${thread.githubPRNumber}`;
          window.open(prUrl, "_blank");
        }}
      >
        <ExternalLink className="h-4 w-4 mr-2" />
        View Pull Request
      </Button>
    );
  } else {
    // Show only one button based on user's preference
    const isDraft = preferredPrType === "draft";
    const isCreating = isDraft ? isCreatingDraftPR : isCreatingPR;

    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => createPR({ draftPR: isDraft })}
        disabled={isCreating}
      >
        <ExternalLink className="h-4 w-4 mr-2" />
        {isDraft ? "Create Draft PR" : "Create Pull Request"}
        {isCreating && <Loader2 className="h-3 w-3 ml-auto animate-spin" />}
      </Button>
    );
  }
}

function ShareButton({
  thread,
  isReadOnly,
}: {
  thread: ThreadInfo;
  isReadOnly: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const updateThreadVisibilityMutation = useUpdateThreadVisibilityMutation();

  const handleVisibilityChange = (visibility: ThreadVisibility) => {
    if (isReadOnly) {
      throw new Error("Cannot change visibility of a read-only task");
    }
    updateThreadVisibilityMutation.mutate({
      threadId: thread.id,
      visibility,
    });
  };

  const copyTaskLink = async () => {
    try {
      const url = `${window.location.origin}/task/${thread.id}`;
      await navigator.clipboard.writeText(url);
      toast.success("Task link copied");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy link", err);
      toast.error("Failed to copy link");
    }
  };

  const visibility = thread.visibility;
  return (
    <>
      <Popover
        open={isOpen}
        onOpenChange={(open: boolean) => {
          if (open) {
            posthog.capture("share_button_clicked", {
              threadId: thread.id,
              currentVisibility: thread.visibility,
            });
          }
          setIsOpen(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="default"
            size="default"
            className="gap-2"
            aria-label="Share this task"
            aria-haspopup="dialog"
            aria-expanded={isOpen}
          >
            {visibility === "private" ? (
              <Lock className="h-3 w-3" aria-hidden="true" />
            ) : visibility === "link" ? (
              <Globe className="h-3 w-3" aria-hidden="true" />
            ) : visibility === "repo" ? (
              <Users className="h-3 w-3" aria-hidden="true" />
            ) : null}
            <span className="hidden sm:inline">Share</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto min-w-[280px] p-0" align="end">
          <div className="flex flex-col">
            <button
              className={`p-3 border-b w-full text-left ${visibility !== "private" ? "cursor-pointer hover:bg-muted/50 transition-colors" : ""}`}
              onClick={visibility !== "private" ? copyTaskLink : undefined}
              disabled={visibility === "private"}
              aria-label={
                visibility !== "private"
                  ? "Copy task link to clipboard"
                  : undefined
              }
              type="button"
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Share this task</h4>
                {visibility !== "private" && (
                  <div className="pointer-events-none" aria-hidden="true">
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Link2 className="size-4" />
                    )}
                  </div>
                )}
              </div>
            </button>

            <div className="">
              <div className="px-3 pt-2 pb-1">
                <p className="text-xs text-muted-foreground">
                  Control who can view this task.
                </p>
              </div>

              {/* Visibility Options */}
              <div className="px-1 py-1">
                <ShareOption
                  visibility="private"
                  isSelected={visibility === "private"}
                  onClick={() => handleVisibilityChange("private")}
                  disabled={isReadOnly}
                />
                <ShareOption
                  visibility="link"
                  isSelected={visibility === "link"}
                  onClick={() => handleVisibilityChange("link")}
                  disabled={isReadOnly}
                />
                <ShareOption
                  visibility="repo"
                  isSelected={visibility === "repo"}
                  onClick={() => handleVisibilityChange("repo")}
                  disabled={isReadOnly}
                />
              </div>

              <div className="border-t p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-6 w-6">
                      {thread.authorImage && (
                        <AvatarImage src={thread.authorImage} />
                      )}
                      <AvatarFallback className="text-xs">
                        {thread.authorName?.charAt(0) || ""}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-xs">{thread.authorName}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">Owner</span>
                </div>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

function ShareOption({
  visibility,
  isSelected,
  onClick,
  disabled,
}: {
  visibility: ThreadVisibility;
  isSelected: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const getLabel = () => {
    switch (visibility) {
      case "private":
        return "Private";
      case "link":
        return "Logged in users with the link";
      case "repo":
        return "Repository members";
      default:
        const _exhaustiveCheck: never = visibility;
        return _exhaustiveCheck && false;
    }
  };

  const getIcon = () => {
    switch (visibility) {
      case "private":
        return <Lock className="h-4 w-4 mr-2" />;
      case "link":
        return <Globe className="h-4 w-4 mr-2" />;
      case "repo":
        return <Users className="h-4 w-4 mr-2" />;
      default:
        return null;
    }
  };

  return (
    <button
      key={visibility}
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center px-3 py-2 rounded-md transition-colors text-left ${
        isSelected
          ? "bg-primary/10 text-primary"
          : !disabled
            ? "hover:bg-muted"
            : ""
      } ${disabled ? "opacity-50" : ""}`}
      aria-label={`Set visibility to ${getLabel()}`}
      aria-pressed={isSelected}
      type="button"
    >
      <span aria-hidden="true">{getIcon()}</span>
      <div className="flex-1">
        <div className="text-sm">{getLabel()}</div>
      </div>
      {isSelected && <Check className="h-3 w-3" aria-label="Selected" />}
    </button>
  );
}

function ShareDrawer({
  thread,
  isReadOnly,
  open,
  onOpenChange,
}: {
  thread: ThreadInfo;
  isReadOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const updateThreadVisibilityMutation = useUpdateThreadVisibilityMutation();

  const handleVisibilityChange = (visibility: ThreadVisibility) => {
    if (isReadOnly) {
      throw new Error("Only the owner can change the visibility of a task");
    }
    updateThreadVisibilityMutation.mutate({
      threadId: thread.id,
      visibility,
    });
  };

  const copyTaskLink = async () => {
    try {
      const url = `${window.location.origin}/task/${thread.id}`;
      await navigator.clipboard.writeText(url);
      toast.success("Task link copied");
      setCopied(true);
      posthog.capture("task_link_copied", {
        threadId: thread.id,
        visibility: thread.visibility,
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy link", err);
      toast.error("Failed to copy link");
    }
  };

  const visibility = thread.visibility;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={true}
      modal={true}
    >
      <DrawerContent className="pb-4">
        <DrawerHeader
          className={`relative p-4 border-b ${visibility !== "private" ? "cursor-pointer active:bg-muted/50 transition-colors" : ""}`}
          onClick={visibility !== "private" ? copyTaskLink : undefined}
          role={visibility !== "private" ? "button" : undefined}
          tabIndex={visibility !== "private" ? 0 : undefined}
          onKeyDown={
            visibility !== "private"
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    copyTaskLink();
                  }
                }
              : undefined
          }
          aria-label={
            visibility !== "private" ? "Copy task link to clipboard" : undefined
          }
        >
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-4 top-1/2 -translate-y-1/2 h-8 w-8 z-10"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChange(false);
            }}
            aria-label="Close share dialog"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <DrawerTitle className="text-left pl-12 pr-12">
            Share this task
          </DrawerTitle>
          {visibility !== "private" && (
            <div
              className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
            </div>
          )}
        </DrawerHeader>

        <div className="flex flex-col">
          {/* Control section */}
          <div className="px-4 pt-4">
            <div className="mb-4">
              <p className="text-sm text-muted-foreground">
                Control who can view this task.
              </p>
            </div>

            {/* Visibility Options */}
            <div className="flex flex-col gap-2">
              <ShareOption
                visibility="private"
                isSelected={visibility === "private"}
                onClick={() => handleVisibilityChange("private")}
                disabled={isReadOnly}
              />
              <ShareOption
                visibility="link"
                isSelected={visibility === "link"}
                onClick={() => handleVisibilityChange("link")}
                disabled={isReadOnly}
              />
              <ShareOption
                visibility="repo"
                isSelected={visibility === "repo"}
                onClick={() => handleVisibilityChange("repo")}
                disabled={isReadOnly}
              />
            </div>
          </div>

          <div className="border-t px-4 pt-4 mt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  {thread.authorImage && (
                    <AvatarImage src={thread.authorImage} />
                  )}
                  <AvatarFallback className="text-xs">
                    {thread.authorName?.charAt(0) || ""}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm">{thread.authorName}</span>
              </div>
              <span className="text-sm text-muted-foreground">Owner</span>
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
