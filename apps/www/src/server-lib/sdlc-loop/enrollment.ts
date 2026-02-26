import { db } from "@/lib/db";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getActiveSdlcLoopForGithubPRAndUser } from "@terragon/shared/model/sdlc-loop";

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
