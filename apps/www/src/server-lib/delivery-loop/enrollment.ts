import { db } from "@/lib/db";
import {
  getActiveSdlcLoopForThread,
  getPreferredActiveSdlcLoopForGithubPRAndUser,
} from "@terragon/shared/model/delivery-loop";
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

  // GitHub webhook/automation-driven tasks keep existing auto-enrollment behavior.
  if (sourceType === "github-mention" || sourceType === "automation") {
    return true;
  }

  return false;
}

export async function getActiveSdlcLoopForGithubPRIfEnabled({
  userId,
  repoFullName,
  prNumber,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
}) {
  return await getPreferredActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
}

export async function getActiveSdlcLoopForThreadIfEnabled({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}) {
  return await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
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
  /** @deprecated v2 always starts in planning — ignored */
  initialState?: "planning" | "implementing";
}) {
  // V2-only enrollment: no v1 sdlcLoop is created
  const { sdlcLoopId } = await enrollV2Workflow({
    db,
    threadId,
    userId,
    repoFullName,
    planApprovalPolicy,
  });

  // For legacy threads that were enrolled with a v1 sdlcLoop, return it
  if (sdlcLoopId) {
    const activeLoop = await getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    if (activeLoop) {
      return activeLoop;
    }
  }

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

  // For legacy threads that were enrolled with a v1 sdlcLoop, return it
  if (v2Result.sdlcLoopId) {
    const activeLoop = await getPreferredActiveSdlcLoopForGithubPRAndUser({
      db,
      userId,
      repoFullName,
      prNumber,
    });
    if (activeLoop) {
      return activeLoop;
    }
  }

  return null;
}
