import { db } from "@/lib/db";
import {
  enrollSdlcLoopForThread,
  getActiveSdlcLoopForThread,
  getPreferredActiveSdlcLoopForGithubPRAndUser,
  linkSdlcLoopToGithubPRForThread,
} from "@terragon/shared/model/delivery-loop";
import { ThreadSource, ThreadSourceMetadata } from "@terragon/shared";
import { SdlcPlanApprovalPolicy } from "@terragon/shared/db/types";
import { ensureV2WorkflowExists } from "./coordinator/enrollment-bridge";
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
  initialState,
}: {
  userId: string;
  repoFullName: string;
  threadId: string;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
  /** @deprecated v2 always starts in planning — this is only used by the v1 fallback path */
  initialState?: "planning" | "implementing";
}) {
  // V2-native enrollment is the primary path: creates v2 workflow directly
  // in planning state and a v1 sdlcLoop compat shim in one shot.
  try {
    const { sdlcLoopId } = await enrollV2Workflow({
      db,
      threadId,
      userId,
      repoFullName,
      planApprovalPolicy,
    });

    // Return the v1 sdlcLoop record for callers that still need it
    const activeLoop = await getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    if (activeLoop) {
      return activeLoop;
    }

    // Shouldn't happen — enrollV2Workflow creates the sdlcLoop compat shim.
    // Return null rather than falling through to the v1 fallback which
    // would create a duplicate sdlcLoop record.
    console.warn(
      "[delivery-loop enrollment] v2 enrollment succeeded but no active v1 loop found",
      { threadId, sdlcLoopId },
    );
    return null;
  } catch (err) {
    console.error(
      "[delivery-loop enrollment] v2-native enrollment failed, falling back to v1 bridge",
      {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Fallback: v1 enrollment with v2 bridge
  const enrolled = await enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName,
    threadId,
    planApprovalPolicy,
    initialState,
  });

  if (enrolled) {
    await tryEnsureV2Workflow({
      threadId,
      sdlcLoopId: enrolled.id,
      sdlcLoopState: enrolled.state,
      sdlcBlockedFromState: enrolled.blockedFromState,
      headSha: enrolled.currentHeadSha,
    });
  }

  return enrolled;
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
  // V2-native enrollment is the primary path (same as thread enrollment)
  try {
    const v2Result = await enrollV2Workflow({
      db,
      threadId,
      userId,
      repoFullName,
      planApprovalPolicy,
    });

    // Link PR to the sdlcLoop compat shim created by enrollV2Workflow
    await linkSdlcLoopToGithubPRForThread({
      db,
      userId,
      repoFullName,
      threadId,
      prNumber,
    });

    // Update the v2 workflow with the PR number
    await updateWorkflowPR({
      db,
      workflowId: v2Result.workflowId,
      prNumber,
    });

    const activeLoop = await getPreferredActiveSdlcLoopForGithubPRAndUser({
      db,
      userId,
      repoFullName,
      prNumber,
    });
    if (activeLoop) {
      return activeLoop;
    }

    console.warn(
      "[delivery-loop enrollment] v2 PR enrollment succeeded but no active loop found",
      { threadId, userId, repoFullName, prNumber },
    );
    return null;
  } catch (err) {
    console.error(
      "[delivery-loop enrollment] v2-native PR enrollment failed, falling back to v1 bridge",
      {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Fallback: v1 enrollment with v2 bridge
  const enrolled = await enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName,
    threadId,
    planApprovalPolicy,
  });
  const linked = await linkSdlcLoopToGithubPRForThread({
    db,
    userId,
    repoFullName,
    threadId,
    prNumber,
  });
  const activeLoop = linked ?? enrolled;

  if (activeLoop) {
    await tryEnsureV2Workflow({
      threadId,
      sdlcLoopId: activeLoop.id,
      sdlcLoopState: activeLoop.state,
      sdlcBlockedFromState: activeLoop.blockedFromState,
      headSha: activeLoop.currentHeadSha,
    });
  }

  if (
    activeLoop &&
    [
      "planning",
      "implementing",
      "review_gate",
      "ci_gate",
      "ui_gate",
      "babysitting",
      "blocked",
    ].includes(activeLoop.state)
  ) {
    return activeLoop;
  }

  const refreshedActiveLoop =
    await getPreferredActiveSdlcLoopForGithubPRAndUser({
      db,
      userId,
      repoFullName,
      prNumber,
    });
  if (refreshedActiveLoop) {
    return refreshedActiveLoop;
  }

  if (activeLoop) {
    console.warn(
      "[delivery-loop enrollment] enrollment did not yield an active loop; returning null",
      {
        userId,
        repoFullName,
        prNumber,
        threadId,
        enrollmentId: activeLoop.id,
        enrollmentState: activeLoop.state,
      },
    );
  }

  return null;
}

async function tryEnsureV2Workflow(params: {
  threadId: string;
  sdlcLoopId: string;
  sdlcLoopState: string;
  sdlcBlockedFromState?: string | null;
  headSha?: string | null;
  userId?: string;
  repoFullName?: string;
  planApprovalPolicy?: string;
}) {
  try {
    await ensureV2WorkflowExists({
      db,
      threadId: params.threadId,
      sdlcLoopId: params.sdlcLoopId,
      sdlcLoopState: params.sdlcLoopState as Parameters<
        typeof ensureV2WorkflowExists
      >[0]["sdlcLoopState"],
      sdlcBlockedFromState: params.sdlcBlockedFromState as Parameters<
        typeof ensureV2WorkflowExists
      >[0]["sdlcBlockedFromState"],
      headSha: params.headSha,
      userId: params.userId,
      repoFullName: params.repoFullName,
      planApprovalPolicy: params.planApprovalPolicy,
    });
  } catch (err) {
    console.error("[delivery-loop enrollment] v2 workflow bridge failed", {
      threadId: params.threadId,
      sdlcLoopId: params.sdlcLoopId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
