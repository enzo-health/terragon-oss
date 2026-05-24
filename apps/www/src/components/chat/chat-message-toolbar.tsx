"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Link, RefreshCw, Split } from "lucide-react";
import type { UIMessage } from "@terragon/shared";
import { getModelDisplayName } from "@terragon/agent/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { RedoTaskDialog } from "./redo-task-dialog";
import { ForkTaskDialog } from "./fork-task-dialog";
import type { RedoDialogData, ForkDialogData } from "./chat-message.types";

// Manual composition (no ActionBarPrimitive.Root) until per-message MessagePrimitive context lands.
const BTN =
  "flex items-center justify-center min-h-[28px] min-w-[28px] sm:min-h-[32px] sm:min-w-[32px] px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-[opacity,color,scale] duration-150 active:scale-[0.98] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring";
const ICON = "h-3.5 w-3.5";
const partsToMd = (ps: UIMessage["parts"]) =>
  ps
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "rich-text"
          ? p.nodes.map((n) => n.text).join("")
          : p.type === "image"
            ? `![](${p.image_url})`
            : "",
    )
    .join("\n");
const flash = (s: (v: boolean) => void) => {
  s(true);
  setTimeout(() => s(false), 2000);
};

export function MessageToolbar({
  message,
  messageIndex,
  className,
  isFirstUserMessage,
  isLatestAgentMessage,
  isAgentWorking,
  redoDialogData,
  forkDialogData,
  taskId,
}: {
  message: UIMessage;
  messageIndex: number;
  className?: string;
  isFirstUserMessage: boolean;
  isLatestAgentMessage: boolean;
  isAgentWorking: boolean;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  taskId?: string;
}) {
  const forkEnabled = useFeatureFlag("forkTask");
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showRedo, setShowRedo] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const parts = message.parts;
  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(partsToMd(parts));
      toast.success("Copied");
      flash(setCopied);
    } catch {
      toast.error("Failed to copy message");
    }
  }, [parts]);
  const handleLink = useCallback(async () => {
    const resolvedTaskId = taskId ?? getTaskIdFromLocation();
    try {
      await copyTextToClipboard(
        `${window.location.origin}/task/${resolvedTaskId}#message-${messageIndex}`,
      );
      toast.success("Link copied");
      flash(setLinkCopied);
    } catch {
      toast.error("Failed to copy link");
    }
  }, [messageIndex, taskId]);
  const model =
    message.role === "user" && message.model
      ? getModelDisplayName(message.model).fullName
      : null;
  const hasText = parts.some(
    (p) => p.type === "text" || p.type === "rich-text",
  );
  const canFork =
    forkEnabled && forkDialogData && isLatestAgentMessage && !isAgentWorking;
  if (!hasText && !model && !isFirstUserMessage && !isLatestAgentMessage)
    return null;
  return (
    <>
      <div
        className={cn(
          "mt-1 flex min-h-[28px] gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100 sm:min-h-[32px]",
          message.role === "agent" ? "justify-start" : "justify-end",
          className,
        )}
      >
        {model && (
          <span
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground rounded-md select-none"
            title={`Model: ${model}`}
          >
            {model}
          </span>
        )}
        {isFirstUserMessage && redoDialogData && (
          <button
            onClick={() => setShowRedo(true)}
            className={BTN}
            title="Retry task"
            aria-label="Retry task"
          >
            <RefreshCw className={ICON} />
          </button>
        )}
        {hasText && (
          <button
            onClick={handleCopy}
            className={BTN}
            title="Copy message"
            aria-label={copied ? "Message copied" : "Copy message"}
          >
            {copied ? <Check className={ICON} /> : <Copy className={ICON} />}
          </button>
        )}
        {hasText && (
          <button
            onClick={handleLink}
            className={BTN}
            title="Copy link to message"
            aria-label={linkCopied ? "Link copied" : "Copy link to message"}
          >
            {linkCopied ? (
              <Check className={ICON} />
            ) : (
              <Link className={ICON} />
            )}
          </button>
        )}
        {canFork && (
          <button
            onClick={() => setShowFork(true)}
            className={BTN}
            title="Fork task"
            aria-label="Fork task from this message"
          >
            <Split className={ICON} />
          </button>
        )}
      </div>
      {showRedo && redoDialogData && (
        <RedoTaskDialog open onOpenChange={setShowRedo} {...redoDialogData} />
      )}
      {showFork && forkDialogData && (
        <ForkTaskDialog open onOpenChange={setShowFork} {...forkDialogData} />
      )}
    </>
  );
}

function getTaskIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/\/task\/([^/?#]+)/);
  return match?.[1] ?? "";
}
