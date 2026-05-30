import { waitUntil } from "@vercel/functions";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import type { SandboxSize } from "@terragon/types/sandbox";
import { getEnvironmentsByRepoFullName } from "@terragon/shared/model/environments";
import { db } from "@/lib/db";
import { triggerEnvironmentSnapshotBuild } from "@/server-lib/environment-snapshot-trigger";

type PushEvent = EmitterWebhookEvent<"push">["payload"];

/**
 * On a push to a repo's default branch, refresh every environment's repo
 * snapshot for that repo so the baked commit tracks the branch tip. Only acts
 * on environments that already hold a Daytona snapshot — a push to a repo
 * nobody has snapshotted does no work. Forced rebuild: the config hashes are
 * unchanged, only the commit moved.
 */
export async function handlePushSnapshotRefresh(
  payload: PushEvent,
): Promise<void> {
  if (payload.deleted) {
    return;
  }
  const repoFullName = payload.repository?.full_name;
  const defaultBranch = payload.repository?.default_branch;
  if (!repoFullName || !defaultBranch) {
    return;
  }
  // Only the base branch is baked into snapshots; ignore pushes to other refs.
  if (payload.ref !== `refs/heads/${defaultBranch}`) {
    return;
  }

  const environments = await getEnvironmentsByRepoFullName({
    db,
    repoFullName,
  });

  for (const environment of environments) {
    const sizes = new Set<SandboxSize>();
    for (const snapshot of environment.snapshots ?? []) {
      if (snapshot.provider === "daytona") {
        sizes.add(snapshot.size);
      }
    }
    for (const size of sizes) {
      waitUntil(
        triggerEnvironmentSnapshotBuild({
          db,
          userId: environment.userId,
          environmentId: environment.id,
          size,
          force: true,
        }),
      );
    }
  }
}
