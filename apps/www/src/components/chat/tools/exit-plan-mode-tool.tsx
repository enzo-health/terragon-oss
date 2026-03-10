import React, { useEffect, useMemo, useRef, useState } from "react";
import { AllToolParts } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { GenericToolPart } from "./generic-ui";
import { resolvePlanText } from "./plan-utils";
import { Button } from "../../ui/button";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { DBMessage } from "@terragon/shared";
import { PromptBoxRef } from "../thread-context";
import { toast } from "sonner";
import { usePlanApproval, useSecondaryPanel } from "../hooks";
import { findArtifactDescriptorForPart } from "../secondary-panel";

function truncatePlanPreview(text: string, maxChars = 150): string {
  if (text.length <= maxChars) return text;
  const cutoff = text.indexOf("\n\n", maxChars);
  const end = cutoff !== -1 ? cutoff : maxChars;
  return text.slice(0, end) + "…";
}

export function ExitPlanModeTool({
  toolPart,
  threadId,
  threadChatId,
  messages,
  isReadOnly,
  promptBoxRef,
  artifactDescriptors = [],
  onOpenArtifact,
}: {
  toolPart: Extract<AllToolParts, { name: "ExitPlanMode" }>;
  threadId: string;
  threadChatId: string;
  messages: DBMessage[];
  isReadOnly: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { setIsSecondaryPanelOpen } = useSecondaryPanel();
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  const plan = useMemo(
    () =>
      resolvePlanText({
        planParam: toolPart.parameters.plan,
        messages,
        exitPlanModeToolId: toolPart.id,
      }),
    [toolPart.parameters.plan, toolPart.id, messages],
  );

  const artifactDescriptor = useMemo(
    () =>
      findArtifactDescriptorForPart({
        artifacts: artifactDescriptors,
        part: toolPart,
      }),
    [artifactDescriptors, toolPart],
  );
  const [copied, setCopied] = useState(false);

  const { handleApprove, isPending, shouldShowApprove } = usePlanApproval({
    threadId,
    threadChatId,
    isReadOnly,
    promptBoxRef,
    toolPartId: toolPart.id,
    messages,
  });

  const handleCopy = async () => {
    if (copied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(plan);
      toast.success("Plan copied");
      setCopied(true);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toast.error("Failed to copy plan");
    }
  };

  const handleOpenPanel = () => {
    if (artifactDescriptor && onOpenArtifact) {
      onOpenArtifact(artifactDescriptor.id);
    } else {
      setIsSecondaryPanelOpen(true);
    }
  };

  const preview = useMemo(
    () => (plan ? truncatePlanPreview(plan) : null),
    [plan],
  );

  return (
    <GenericToolPart toolName="Plan" toolArg="" toolStatus="completed">
      <div className="relative group">
        {plan && (
          <div className="absolute top-2 right-2 z-10 flex gap-1">
            {artifactDescriptor && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 bg-muted/80 hover:bg-muted"
                onClick={handleOpenPanel}
                title="Open in side panel"
                aria-label="Open plan in side panel"
              >
                <ExternalLink className="size-3" aria-hidden />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 bg-muted/80 hover:bg-muted"
              onClick={handleCopy}
              title="Copy plan"
            >
              {copied ? (
                <Check className="size-3" />
              ) : (
                <Copy className="size-3" />
              )}
            </Button>
          </div>
        )}
        <div className="p-3 bg-muted/50 rounded-md space-y-3">
          <div className="max-w-none font-sans pr-10">
            {preview ? (
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {preview}
              </p>
            ) : (
              <span className="text-muted-foreground italic">
                (No plan content available)
              </span>
            )}
          </div>
          {shouldShowApprove && (
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={handleApprove}
                className="flex items-center gap-2 font-sans"
                disabled={isPending}
              >
                <Check className="h-4 w-4" />
                Approve
              </Button>
            </div>
          )}
        </div>
      </div>
    </GenericToolPart>
  );
}
