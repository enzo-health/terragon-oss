import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import type { SandboxSize } from "@terragon/types/sandbox";
import { getEnvironmentsWithSnapshots } from "@terragon/shared/model/environments";
import {
  deleteRepoSnapshot,
  listRepoSnapshotNames,
} from "@terragon/sandbox/snapshot-builder";
import { db } from "@/lib/db";
import { triggerEnvironmentSnapshotBuild } from "@/server-lib/environment-snapshot-trigger";

// A ready snapshot older than this is refreshed even without a push webhook —
// covers missed/undelivered pushes and repos where the app lacks push events.
const SNAPSHOT_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
// Don't reap a Daytona snapshot younger than this; it may belong to a build
// that just created its image but hasn't written `ready` to the DB yet.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

// Force a rebuild of every ready Daytona snapshot whose baked commit is older
// than the refresh window. Serialized so a daily sweep doesn't spawn a burst of
// concurrent Daytona builds; the in-progress debounce drops duplicates.
async function refreshStaleSnapshots(): Promise<number> {
  const environments = await getEnvironmentsWithSnapshots({ db });
  const now = Date.now();
  let refreshed = 0;
  for (const environment of environments) {
    const sizes = new Set<SandboxSize>();
    for (const snapshot of environment.snapshots ?? []) {
      if (
        snapshot.provider !== "daytona" ||
        snapshot.status !== "ready" ||
        !snapshot.snapshotName
      ) {
        continue;
      }
      const builtAt = Date.parse(snapshot.builtAt);
      if (Number.isNaN(builtAt) || now - builtAt > SNAPSHOT_REFRESH_AGE_MS) {
        sizes.add(snapshot.size);
      }
    }
    for (const size of sizes) {
      await triggerEnvironmentSnapshotBuild({
        db,
        userId: environment.userId,
        environmentId: environment.id,
        size,
        force: true,
      });
      refreshed++;
    }
  }
  return refreshed;
}

// Delete Daytona `repo-…` snapshots that no environment references — the debris
// left when a build's image was created but the run died before recording it,
// or a delete-on-supersede call failed.
async function reapOrphanSnapshots(): Promise<number> {
  const environments = await getEnvironmentsWithSnapshots({ db });
  const referenced = new Set<string>();
  for (const environment of environments) {
    for (const snapshot of environment.snapshots ?? []) {
      if (snapshot.snapshotName) {
        referenced.add(snapshot.snapshotName);
      }
    }
  }

  const daytonaNames = await listRepoSnapshotNames();
  const now = Date.now();
  let reaped = 0;
  for (const name of daytonaNames) {
    if (referenced.has(name)) {
      continue;
    }
    // Names end with `-<Date.now()>`; skip recently-created ones to avoid
    // racing a build that hasn't persisted its DB entry yet.
    const builtAtMs = Number(name.split("-").pop());
    if (!Number.isNaN(builtAtMs) && now - builtAtMs < ORPHAN_MIN_AGE_MS) {
      continue;
    }
    try {
      await deleteRepoSnapshot(name);
      reaped++;
    } catch (error) {
      console.error(`[refresh-snapshots] failed to reap ${name}:`, error);
    }
  }
  return reaped;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("[refresh-snapshots] cron started");
  let refreshed = 0;
  let reaped = 0;
  try {
    refreshed = await refreshStaleSnapshots();
  } catch (error) {
    console.error("[refresh-snapshots] refresh pass failed:", error);
  }
  try {
    reaped = await reapOrphanSnapshots();
  } catch (error) {
    console.error("[refresh-snapshots] reap pass failed:", error);
  }
  console.log(
    `[refresh-snapshots] cron done — refreshed ${refreshed}, reaped ${reaped}`,
  );
  return Response.json({ success: true, refreshed, reaped });
}
