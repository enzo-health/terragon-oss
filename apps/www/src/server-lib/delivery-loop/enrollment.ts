import { db } from "@/lib/db";
import { ThreadSource, ThreadSourceMetadata } from "@leo/shared";
import { DeliveryPlanApprovalPolicy } from "@leo/shared/db/types";
import { enrollWorkflow } from "./v3/enrollment";
import { updateWorkflowPR } from "@leo/shared/delivery-loop/store/workflow-store";

export function isDeliveryLoopEnrollmentAllowedForThread({
  sourceType,
  sourceMetadata,
}: {
  sourceType: ThreadSource | null;
  sourceMetadata: ThreadSourceMetadata | null;
}) {
  if (!sourceType) {
    return false;
  }

  // Dashboard-created web tasks must explicitly opt in.
  if (sourceType === "www") {
    return sourceMetadata?.type === "www" && sourceMetadata.deliveryLoopOptIn;
  }

  // GitHub webhook/automation-driven tasks and CLI tasks keep existing auto-enrollment behavior.
  if (
    sourceType === "github-mention" ||
    sourceType === "automation" ||
    sourceType === "cli"
  ) {
    return true;
  }

  if (sourceType === "linear-mention") {
    return (
      sourceMetadata?.type === "linear-mention" &&
      sourceMetadata.deliveryLoopOptIn === true
    );
  }

  return false;
}

export async function ensureDeliveryLoopEnrollmentForThreadIfEnabled({
  userId,
  repoFullName,
  threadId,
  planApprovalPolicy,
}: {
  userId: string;
  repoFullName: string;
  threadId: string;
  planApprovalPolicy?: DeliveryPlanApprovalPolicy;
}) {
  await enrollWorkflow({
    db,
    threadId,
    userId,
    repoFullName,
    planApprovalPolicy,
  });

  return null;
}

export async function ensureDeliveryLoopEnrollmentForGithubPRIfEnabled({
  userId,
  repoFullName,
  prNumber,
  threadId,
  planApprovalPolicy,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
  threadId: string;
  planApprovalPolicy?: DeliveryPlanApprovalPolicy;
}) {
  const result = await enrollWorkflow({
    db,
    threadId,
    userId,
    repoFullName,
    planApprovalPolicy,
  });

  await updateWorkflowPR({
    db,
    workflowId: result.workflowId,
    prNumber,
  });

  return null;
}
