import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Link, RefreshCw, Split } from "lucide-react";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { DBUserMessage, GitDiffStats, UIMessage } from "@terragon/shared";
import { cn } from "@/lib/utils";
import { useParams } from "next/navigation";
import { getModelDisplayName } from "@terragon/agent/utils";
import { RedoTaskDialog } from "./redo-task-dialog";
import { ForkTaskDialog } from "./fork-task-dialog";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

type RedoDialogData = {
  threadId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  permissionMode: "allowAll" | "plan";
  initialUserMessage: DBUserMessage;
};

type ForkDialogData = {
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  branchName: string | null;
  gitDiffStats: GitDiffStats | null;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  agent: AIAgent;
  lastSelectedModel: AIModel | null;
};

function getTextContent(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "rich-text") {
        return part.nodes.map((node) => node.text).join("");
      }
      if (part.type === "image") {
        return `![](${part.image_url})`;
      }
      return "";
    })
    .join("\n");
}

function getModelNameFromMessage(message: UIMessage): string | null {
  if (message.role === "user" && message.model) {
    return getModelDisplayName(message.model).fullName;
  }
  return null;
}

export function MessageToolbar({
  message,
  messageIndex,
  className,
  isFirstUserMessage,
  isLatestAgentMessage,
  isAgentWorking,
  redoDialogData,
  forkDialogData,
}: {
  message: UIMessage;
  messageIndex: number;
  className?: string;
  isFirstUserMessage: boolean;
  isLatestAgentMessage: boolean;
  isAgentWorking: boolean;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
}) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showRedoDialog, setShowRedoDialog] = useState(false);
  const [showForkDialog, setShowForkDialog] = useState(false);
  const params = useParams();
  const isForkTaskEnabled = useFeatureFlag("forkTask");

  const handleCopy = async () => {
    if (copied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(getTextContent(message));
      toast.success("Copied");
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toast.error("Failed to copy message");
    }
  };

  const handleCopyLink = async () => {
    if (linkCopied || messageIndex === undefined) {
      return;
    }
    try {
      const threadId = params.id as string;
      const url = `${window.location.origin}/task/${threadId}#message-${messageIndex}`;
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
      setLinkCopied(true);
      setTimeout(() => {
        setLinkCopied(false);
      }, 2000);
    } catch (error) {
      toast.error("Failed to copy link");
    }
  };

  // Get model display name for user messages
  const modelDisplay = getModelNameFromMessage(message);
  const hasTextContent = message.parts.some(
    (part) => part.type === "text" || part.type === "rich-text",
  );
  // Only show the toolbar if there is text content in the message or if it's a user message with model info
  if (
    !hasTextContent &&
    !modelDisplay &&
    !isFirstUserMessage &&
    !isLatestAgentMessage
  ) {
    return null;
  }
  return (
    <>
      <div
        className={cn(
          "flex gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity",
          {
            "justify-start": message.role === "agent",
            "justify-end": message.role === "user",
          },
          className,
        )}
      >
        {modelDisplay && (
          <span
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground rounded-md select-none"
            title={`Model: ${modelDisplay}`}
          >
            <span>{modelDisplay}</span>
          </span>
        )}
        {isFirstUserMessage && redoDialogData && (
          <button
            onClick={() => setShowRedoDialog(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            title="Retry task"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
        {hasTextContent && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            title="Copy message"
          >
            {copied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        )}
        {messageIndex !== undefined && hasTextContent && (
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            title="Copy link to message"
          >
            {linkCopied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Link className="h-3 w-3" />
            )}
          </button>
        )}
        {isForkTaskEnabled &&
          forkDialogData &&
          isLatestAgentMessage &&
          !isAgentWorking && (
            <button
              onClick={() => setShowForkDialog(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
              title="Fork task"
            >
              <Split className="h-3 w-3" />
            </button>
          )}
      </div>
      {showRedoDialog && redoDialogData && (
        <RedoTaskDialog
          open={showRedoDialog}
          threadId={redoDialogData.threadId}
          repoFullName={redoDialogData.repoFullName}
          repoBaseBranchName={redoDialogData.repoBaseBranchName}
          disableGitCheckpointing={redoDialogData.disableGitCheckpointing}
          skipSetup={redoDialogData.skipSetup}
          permissionMode={redoDialogData.permissionMode}
          initialUserMessage={redoDialogData.initialUserMessage}
          onOpenChange={setShowRedoDialog}
        />
      )}
      {showForkDialog && forkDialogData && (
        <ForkTaskDialog
          open={showForkDialog}
          threadId={forkDialogData.threadId}
          threadChatId={forkDialogData.threadChatId}
          repoFullName={forkDialogData.repoFullName}
          repoBaseBranchName={forkDialogData.repoBaseBranchName}
          branchName={forkDialogData.branchName}
          gitDiffStats={forkDialogData.gitDiffStats}
          disableGitCheckpointing={forkDialogData.disableGitCheckpointing}
          skipSetup={forkDialogData.skipSetup}
          agent={forkDialogData.agent}
          lastSelectedModel={forkDialogData.lastSelectedModel}
          onOpenChange={setShowForkDialog}
        />
      )}
    </>
  );
}
