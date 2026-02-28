import { db } from "@/lib/db";
import {
  enrollSdlcLoopForThread,
  getActiveSdlcLoopForThread,
  getPreferredActiveSdlcLoopForGithubPRAndUser,
  linkSdlcLoopToGithubPRForThread,
} from "@terragon/shared/model/sdlc-loop";
import { ThreadSource, ThreadSourceMetadata } from "@terragon/shared";
import { SdlcPlanApprovalPolicy } from "@terragon/shared/db/types";

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
}) {
  return await enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName,
    threadId,
    planApprovalPolicy,
  });
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
  if (
    activeLoop &&
    [
      "planning",
      "implementing",
      "reviewing",
      "ui_testing",
      "pr_babysitting",
      "blocked_on_agent_fixes",
      "blocked_on_ci",
      "blocked_on_review_threads",
      "blocked_on_human_feedback",
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
      "[sdlc-loop enrollment] enrollment did not yield an active loop; returning null",
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
