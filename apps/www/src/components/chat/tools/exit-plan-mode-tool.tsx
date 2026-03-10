import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AllToolParts } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { GenericToolPart } from "./generic-ui";
import { resolvePlanText } from "./plan-utils";
import { TextPart } from "../text-part";
import { Button } from "../../ui/button";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { DBMessage } from "@terragon/shared";
import { PromptBoxRef } from "../thread-context";
import { toast } from "sonner";
import { approvePlan } from "@/server-actions/approve-plan";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { useOptimisticUpdateThreadChat, useSecondaryPanel } from "../hooks";
import { findArtifactDescriptorForPart } from "../secondary-panel";

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
  const updateThreadChat = useOptimisticUpdateThreadChat({
    threadId,
    threadChatId,
  });
  // Only show buttons if this is the active ExitPlanMode tool
  const shouldShowButtons = useMemo(() => {
    if (isReadOnly) {
      return false;
    }
    // Calculate which ExitPlanMode tool should show buttons
    let lastExitPlanModeId: string | null = null;
    // Iterate backwards through messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      // If we hit a user message, stop looking
      if (message.type === "user") {
        break;
      }
      if (message.type === "tool-call" && message.name === "ExitPlanMode") {
        lastExitPlanModeId = message.id;
        break;
      }
    }
    return lastExitPlanModeId === toolPart.id;
  }, [isReadOnly, messages, toolPart.id]);

  const handleApproveMutation = useServerActionMutation({
    mutationFn: approvePlan,
  });

  const handleApprove = useCallback(async () => {
    if (isReadOnly) {
      return;
    }
    // Switch promptbox to execute mode (allowAll)
    promptBoxRef?.current?.setPermissionMode("allowAll");
    updateThreadChat({ permissionMode: "allowAll" });
    await handleApproveMutation.mutateAsync({
      threadId,
      threadChatId,
    });
  }, [
    isReadOnly,
    threadId,
    threadChatId,
    promptBoxRef,
    handleApproveMutation,
    updateThreadChat,
  ]);

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

  // Show a placeholder if the plan is empty
  const displayPlan = plan || "(No plan content available)";

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
            {plan ? (
              <TextPart text={plan} />
            ) : (
              <span className="text-muted-foreground italic">
                {displayPlan}
              </span>
            )}
          </div>
          {shouldShowButtons && (
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={handleApprove}
                className="flex items-center gap-2 font-sans"
                disabled={handleApproveMutation.isPending}
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
