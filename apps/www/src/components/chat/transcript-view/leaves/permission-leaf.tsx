"use client";

import { Check, ShieldAlert, X } from "lucide-react";
import {
  Confirmation,
  ConfirmationAccept,
  ConfirmationAction,
  ConfirmationApproved,
  ConfirmationDescription,
  ConfirmationHeader,
  ConfirmationIcon,
  ConfirmationPending,
  ConfirmationReject,
  ConfirmationRejected,
  ConfirmationStatus,
  ConfirmationTitle,
} from "@/components/ai/confirmation";
import { cn } from "@/lib/utils";
import type { PermissionItem } from "../../transcript-store";
import type { Leaf } from "../leaf-props";
import { useTranscriptViewContext } from "../transcript-view-context";

const DECISION_BUTTON = cn(
  "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
  "transition-colors disabled:opacity-50 disabled:pointer-events-none",
);

function confirmationState(
  status: PermissionItem["status"],
): "pending" | "approved" | "rejected" {
  if (status === "approved") return "approved";
  if (status === "denied") return "rejected";
  return "pending";
}

export const PermissionLeaf: Leaf<"permission"> = ({ item }) => {
  const { respondToPermission, isReadOnly } = useTranscriptViewContext();
  const disabled = isReadOnly || !respondToPermission;

  return (
    <Confirmation
      className="my-2"
      tone="danger"
      state={confirmationState(item.status)}
    >
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldAlert />
        </ConfirmationIcon>
        <ConfirmationTitle>{item.title}</ConfirmationTitle>
      </ConfirmationHeader>
      {item.description ? (
        <ConfirmationDescription>{item.description}</ConfirmationDescription>
      ) : null}
      <ConfirmationPending>
        <ConfirmationAction>
          <ConfirmationReject
            className={cn(
              DECISION_BUTTON,
              "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            disabled={disabled}
            onClick={() =>
              respondToPermission?.(item.permissionRequestId, "denied")
            }
          >
            <X className="size-4" />
            Deny
          </ConfirmationReject>
          <ConfirmationAccept
            className={cn(
              DECISION_BUTTON,
              "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            disabled={disabled}
            onClick={() =>
              respondToPermission?.(item.permissionRequestId, "approved")
            }
          >
            <Check className="size-4" />
            Approve
          </ConfirmationAccept>
        </ConfirmationAction>
      </ConfirmationPending>
      <ConfirmationApproved>
        <ConfirmationStatus>
          <Check />
          Approved
        </ConfirmationStatus>
      </ConfirmationApproved>
      <ConfirmationRejected>
        <ConfirmationStatus>
          <X />
          Denied
        </ConfirmationStatus>
      </ConfirmationRejected>
    </Confirmation>
  );
};
