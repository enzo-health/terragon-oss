import type {
  DBMessage,
  UIPlanPart,
  UIStructuredPlanPart,
} from "@terragon/shared";
import {
  type ExitPlanModeToolPart,
  type PlanArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import React, { useMemo } from "react";
import { TextPart } from "./text-part";
import type { PromptBoxRef } from "./thread-context";
import { resolvePlanText } from "./tools/plan-utils";

export function PlanArtifactRenderer({
  descriptor,
  messages = [],
}: {
  descriptor: PlanArtifactDescriptor;
  messages?: DBMessage[];
  threadId?: string;
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
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

    if (descriptor.part.type === "plan-structured") {
      return renderStructuredPlanText(descriptor.part);
    }

    const planPart = descriptor.part as UIPlanPart;
    return planPart.planText;
  }, [descriptor, messages]);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-lg border bg-card p-3">
        <div className="max-w-none font-sans prose prose-sm">
          {planText ? (
            <TextPart text={planText} />
          ) : (
            <p className="text-muted-foreground italic">
              (No plan content available)
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function renderStructuredPlanText(part: UIStructuredPlanPart): string {
  return part.entries
    .map((entry) => {
      const marker = entry.status === "completed" ? "x" : " ";
      return `- [${marker}] ${entry.content}`;
    })
    .join("\n");
}
