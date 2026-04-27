import type { DBMessage } from "@terragon/shared";
import { AllToolParts } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { Check, Copy, ExternalLink } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../ui/button";
import { useSecondaryPanel } from "../hooks";
import { findArtifactDescriptorForPart } from "../secondary-panel";
import type { PromptBoxRef } from "../thread-context";
import { GenericToolPart } from "./generic-ui";
import { resolvePlanText } from "./plan-utils";

export function truncateAtWordBoundary(text: string, maxChars = 300): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  const end = lastSpace > maxChars * 0.5 ? lastSpace : maxChars;
  return text.slice(0, end) + "...";
}

export function ExitPlanModeTool({
  toolPart,
  messages,
  artifactDescriptors = [],
  onOpenArtifact,
}: {
  toolPart: Extract<AllToolParts, { name: "ExitPlanMode" }>;
  threadId: string;
  threadChatId: string;
  messages: DBMessage[];
  isReadOnly: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
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

  const freeFormPreview = useMemo(
    () => (plan ? truncateAtWordBoundary(plan) : null),
    [plan],
  );

  return (
    <GenericToolPart toolName="Plan" toolArg="" toolStatus="completed">
      <div className="relative group">
        {plan && (
          <div className="absolute top-2 right-2 z-10 flex gap-1">
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
            {freeFormPreview ? (
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {freeFormPreview}
              </p>
            ) : (
              <span className="text-muted-foreground italic">
                (No plan content available)
              </span>
            )}
          </div>
        </div>
      </div>
    </GenericToolPart>
  );
}
