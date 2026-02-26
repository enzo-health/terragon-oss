import { db } from "@/lib/db";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  enrollSdlcLoopForGithubPR,
  getActiveSdlcLoopForGithubPRAndUser,
} from "@terragon/shared/model/sdlc-loop";

export async function getActiveSdlcLoopForGithubPRIfEnabled({
  userId,
  repoFullName,
  prNumber,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
}) {
  const enabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "sdlcLoopCoordinatorRouting",
  });
  if (!enabled) {
    return null;
  }

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
  const enabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "sdlcLoopCoordinatorRouting",
  });
  if (!enabled) {
    return null;
  }

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
