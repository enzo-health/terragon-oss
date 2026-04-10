import { DBMessage, type UIPlanPart } from "@leo/shared";
import {
  type ExitPlanModeToolPart,
  type PlanArtifactDescriptor,
} from "@leo/shared/db/artifact-descriptors";
import { Check } from "lucide-react";
import React, { useMemo } from "react";
import { DeliveryLoopPlanReviewCard } from "@/components/patterns/delivery-loop-plan-review-card";
import { Button } from "@/components/ui/button";
import { parsePlanSpecViewModelFromText } from "@/lib/delivery-loop-plan-view-model";
import { usePlanApproval } from "./hooks";
import { TextPart } from "./text-part";
import type { PromptBoxRef } from "./thread-context";
import { resolvePlanText } from "./tools/plan-utils";

export function PlanArtifactRenderer({
  descriptor,
  messages = [],
  threadId,
  threadChatId,
  isReadOnly = false,
  promptBoxRef,
}: {
  descriptor: PlanArtifactDescriptor;
  messages?: DBMessage[];
  threadId?: string;
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  const planText = useMemo(() => {
    if (descriptor.origin.type === "plan-tool") {
      const toolPart = descriptor.part as ExitPlanModeToolPart;
      return resolvePlanText({
        planParam: toolPart.parameters?.plan,
        messages,
        exitPlanModeToolId: toolPart.id,
      });
    }

    const planPart = descriptor.part as UIPlanPart;
    return planPart.planText;
  }, [descriptor, messages]);

  const toolPartId =
    descriptor.origin.type === "plan-tool"
      ? (descriptor.part as ExitPlanModeToolPart).id
      : undefined;

  const { handleApprove, isPending, shouldShowApprove } = usePlanApproval({
    threadId,
    threadChatId,
    isReadOnly,
    promptBoxRef,
    toolPartId,
    messages,
  });

  // For delivery loop plans, try to parse as structured plan
  const deliveryLoopPlan = useMemo(() => {
    if (descriptor.origin.type !== "tool-part" || !planText) return null;
    return parsePlanSpecViewModelFromText(planText);
  }, [descriptor.origin.type, planText]);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        {deliveryLoopPlan ? (
          <DeliveryLoopPlanReviewCard plan={deliveryLoopPlan} />
        ) : (
          <div className="max-w-none font-sans prose prose-sm">
            {planText ? (
              <TextPart text={planText} />
            ) : (
              <p className="text-muted-foreground italic">
                (No plan content available)
              </p>
            )}
          </div>
        )}
        {shouldShowApprove && (
          <div className="flex gap-2 pt-4 border-t mt-4">
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
  );
}
