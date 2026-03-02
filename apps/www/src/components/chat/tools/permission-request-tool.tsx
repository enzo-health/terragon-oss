import React, { useCallback, useMemo } from "react";
import { AllToolParts } from "@terragon/shared";
import { GenericToolPart } from "./generic-ui";
import { Button } from "../../ui/button";
import { Check, X } from "lucide-react";
import { useThread } from "../thread-context";
import { respondToPermission } from "@/server-actions/respond-to-permission";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function PermissionRequestTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "PermissionRequest" }>;
}) {
  const { threadChat, isReadOnly } = useThread();

  const shouldShowButtons = useMemo(() => {
    if (isReadOnly || !threadChat) return false;
    // Only show buttons if this tool call is still pending (no result yet)
    return toolPart.status === "pending";
  }, [isReadOnly, threadChat, toolPart.status]);

  const respondMutation = useServerActionMutation({
    mutationFn: respondToPermission,
  });

  const handleRespond = useCallback(
    async (optionId: string) => {
      if (!threadChat) return;
      await respondMutation.mutateAsync({
        threadId: threadChat.threadId,
        threadChatId: threadChat.id,
        promptId: toolPart.id,
        optionId,
      });
    },
    [threadChat, respondMutation, toolPart.id],
  );

  const isCompleted =
    toolPart.status === "completed" || toolPart.status === "error";
  const wasApproved =
    isCompleted &&
    "result" in toolPart &&
    toolPart.result === "Permission granted";

  return (
    <GenericToolPart
      toolName="Permission Request"
      toolArg={toolPart.parameters.tool_name || null}
      toolStatus={toolPart.status}
    >
      <div className="p-3 bg-muted/50 rounded-md space-y-3">
        <p className="text-sm font-sans">
          {toolPart.parameters.description ||
            "Agent is requesting permission to proceed."}
        </p>
        {shouldShowButtons && (
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              onClick={() => handleRespond("approved")}
              className="flex items-center gap-2 font-sans"
              disabled={respondMutation.isPending}
            >
              <Check className="h-4 w-4" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleRespond("denied")}
              className="flex items-center gap-2 font-sans"
              disabled={respondMutation.isPending}
            >
              <X className="h-4 w-4" />
              Deny
            </Button>
          </div>
        )}
        {isCompleted && (
          <p className="text-sm text-muted-foreground font-sans">
            {wasApproved ? "Approved" : "Denied"}
          </p>
        )}
      </div>
    </GenericToolPart>
  );
}
