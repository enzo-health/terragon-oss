import { db } from "@/lib/db";
import {
  enrollSdlcLoopForGithubPR,
  getActiveSdlcLoopForGithubPRAndUser,
} from "@terragon/shared/model/sdlc-loop";
import { ThreadSource, ThreadSourceMetadata } from "@terragon/shared";

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
  return await getActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
}

export async function ensureSdlcLoopEnrollmentForGithubPRIfEnabled({
  userId,
  repoFullName,
  prNumber,
  threadId,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
  threadId: string;
}) {
  const activeLoop = await getActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
  if (activeLoop) {
    return activeLoop;
  }

  const enrolled = await enrollSdlcLoopForGithubPR({
    db,
    userId,
    repoFullName,
    prNumber,
    threadId,
  });
  if (
    enrolled &&
    [
      "enrolled",
      "implementing",
      "gates_running",
      "blocked_on_agent_fixes",
      "blocked_on_ci",
      "blocked_on_review_threads",
      "video_pending",
      "human_review_ready",
      "video_degraded_ready",
      "blocked_on_human_feedback",
    ].includes(enrolled.state)
  ) {
    return enrolled;
  }

  const refreshedActiveLoop = await getActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
  if (refreshedActiveLoop) {
    return refreshedActiveLoop;
  }

  if (enrolled) {
    console.warn(
      "[sdlc-loop enrollment] enrollment did not yield an active loop; returning null",
      {
        userId,
        repoFullName,
        prNumber,
        threadId,
        enrollmentId: enrolled.id,
        enrollmentState: enrolled.state,
      },
    );
  }

  return null;
}
