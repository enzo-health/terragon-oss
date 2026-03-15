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
  initialState?: "planning" | "implementing";
}) {
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
  initialState,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
  threadId: string;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
  initialState?: "planning" | "implementing";
}) {
  const enrolled = await enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName,
    threadId,
    planApprovalPolicy,
    initialState,
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
    });
  } catch (err) {
    console.error("[delivery-loop enrollment] v2 workflow bridge failed", {
      threadId: params.threadId,
      sdlcLoopId: params.sdlcLoopId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
