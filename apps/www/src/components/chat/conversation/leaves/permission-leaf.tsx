"use client";

import { Check, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ai/button";
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
import type { PermissionItem } from "../../transcript-store";
import type { Leaf } from "../leaf-props";
import { useConversationContext } from "../conversation-context";

function confirmationState(
  status: PermissionItem["status"],
): "pending" | "approved" | "rejected" {
  if (status === "approved") return "approved";
  if (status === "denied") return "rejected";
  return "pending";
}

export const PermissionLeaf: Leaf<"permission"> = ({ item }) => {
  const { respondToPermission, isReadOnly } = useConversationContext();
  const disabled = isReadOnly || !respondToPermission;

  return (
    <Confirmation tone="danger" state={confirmationState(item.status)}>
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
            render={<Button variant="ghost" />}
            disabled={disabled}
            onClick={() =>
              respondToPermission?.(item.permissionRequestId, "denied")
            }
          >
            <X />
            Deny
          </ConfirmationReject>
          <ConfirmationAccept
            render={<Button variant="primary" />}
            disabled={disabled}
            onClick={() =>
              respondToPermission?.(item.permissionRequestId, "approved")
            }
          >
            <Check />
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
