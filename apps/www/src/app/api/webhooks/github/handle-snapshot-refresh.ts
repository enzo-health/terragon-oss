import { waitUntil } from "@vercel/functions";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { db } from "@/lib/db";
import { refreshEnvironmentSnapshotsForRepo } from "@/server-lib/environment-snapshot-lifecycle";

type PushEvent = EmitterWebhookEvent<"push">["payload"];

export async function handlePushSnapshotRefresh(
  payload: PushEvent,
): Promise<void> {
  if (payload.deleted) {
    return;
  }
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return;
  }
  const branchPrefix = "refs/heads/";
  if (!payload.ref?.startsWith(branchPrefix)) {
    return;
  }
  const baseBranch = payload.ref.slice(branchPrefix.length);
  const includeLegacyBranchless =
    baseBranch === payload.repository.default_branch;

  waitUntil(
    refreshEnvironmentSnapshotsForRepo({
      db,
      repoFullName,
      baseBranch,
      includeLegacyBranchless,
    }),
  );
}
