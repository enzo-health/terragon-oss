import { db } from "@/lib/db";
import { ThreadSource, ThreadSourceMetadata } from "@terragon/shared";
import { SdlcPlanApprovalPolicy } from "@terragon/shared/db/types";
import { enrollV2Workflow } from "./coordinator/v2-enrollment";
import { updateWorkflowPR } from "@terragon/shared/delivery-loop/store/workflow-store";

export function isSdlcLoopEnrollmentAllowedForThread({
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
    return sourceMetadata?.type === "www" && sourceMetadata.sdlcLoopOptIn;
  }

  // GitHub webhook/automation-driven tasks and CLI tasks keep existing auto-enrollment behavior.
  if (
    sourceType === "github-mention" ||
    sourceType === "automation" ||
    sourceType === "cli"
  ) {
    return true;
  }

  return false;
}

export async function ensureSdlcLoopEnrollmentForThreadIfEnabled({
  userId,
  repoFullName,
  threadId,
  planApprovalPolicy,
}: {
  userId: string;
  repoFullName: string;
  threadId: string;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
}) {
  // V2-only enrollment: creates the v2 workflow as a side-effect
  await enrollV2Workflow({
    db,
    threadId,
    userId,
    repoFullName,
    planApprovalPolicy,
  });

  return null;
}

export async function ensureSdlcLoopEnrollmentForGithubPRIfEnabled({
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
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
}) {
  // V2-only enrollment with PR number set directly on workflow
  const v2Result = await enrollV2Workflow({
    db,
    threadId,
    userId,
    repoFullName,
    planApprovalPolicy,
  });

  // Update the v2 workflow with the PR number
  await updateWorkflowPR({
    db,
    workflowId: v2Result.workflowId,
    prNumber,
  });

  return null;
}
