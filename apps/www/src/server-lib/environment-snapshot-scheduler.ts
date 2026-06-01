import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { DB } from "@terragon/shared/db";
import type { SandboxSize } from "@terragon/types/sandbox";
import {
  getEnvironmentsByRepoFullName,
  getEnvironmentsWithSnapshots,
  markSnapshotsStale,
} from "@terragon/shared/model/environments";
import {
  deleteRepoSnapshot,
  listRepoSnapshotNames,
} from "@terragon/sandbox/snapshot-builder";
import { triggerEnvironmentSnapshotBuild } from "./environment-snapshot-trigger";

export const SNAPSHOT_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export type EnvironmentSnapshotScheduleReason =
  | "manual"
  | "environment-created"
  | "environment-config-changed"
  | "boot-miss"
  | "snapshot-refresh-failed"
  | "github-base-push"
  | "cron-stale-refresh";

export type EnvironmentSnapshotScheduleRequest = {
  reason: EnvironmentSnapshotScheduleReason;
  requestedSize?: SandboxSize;
  bootSize?: SandboxSize;
  existingSnapshotSizes?: readonly SandboxSize[];
};

export type EnvironmentSnapshotSchedulePlan = {
  sizes: SandboxSize[];
  force: boolean;
  markExistingStale: boolean;
};

export type EnvironmentSnapshotScheduleResult =
  EnvironmentSnapshotSchedulePlan & {
    scheduled: number;
  };

export type VerifiedSnapshotRepository = {
  fullName: string;
  defaultBranch: string;
};

export type EnvironmentSnapshotMaintenanceResult = {
  refreshed: number;
  reaped: number;
};

export function planEnvironmentSnapshotSchedule(
  request: EnvironmentSnapshotScheduleRequest,
): EnvironmentSnapshotSchedulePlan {
  switch (request.reason) {
    case "manual":
      return {
        sizes: [request.requestedSize ?? "small"],
        force: true,
        markExistingStale: false,
      };
    case "environment-created":
      return { sizes: ["small"], force: false, markExistingStale: false };
    case "environment-config-changed":
      return { sizes: ["small"], force: false, markExistingStale: true };
    case "boot-miss":
      return {
        sizes: [request.bootSize ?? request.requestedSize ?? "small"],
        force: false,
        markExistingStale: false,
      };
    case "snapshot-refresh-failed":
      return {
        sizes: [request.bootSize ?? request.requestedSize ?? "small"],
        force: true,
        markExistingStale: false,
      };
    case "github-base-push":
      return {
        sizes: uniqueSnapshotSizes(request.existingSnapshotSizes ?? []),
        force: true,
        markExistingStale: false,
      };
    case "cron-stale-refresh":
      return {
        sizes: uniqueSnapshotSizes(request.existingSnapshotSizes ?? []),
        force: true,
        markExistingStale: false,
      };
  }
}

export function getDaytonaSnapshotSizes(
  snapshots: readonly EnvironmentSnapshot[] | null | undefined,
): SandboxSize[] {
  return uniqueSnapshotSizes(
    (snapshots ?? [])
      .filter((snapshot) => snapshot.provider === "daytona")
      .map((snapshot) => snapshot.size),
  );
}

export function getStaleReadyDaytonaSnapshotSizes({
  snapshots,
  now = Date.now(),
  refreshAgeMs = SNAPSHOT_REFRESH_AGE_MS,
}: {
  snapshots: readonly EnvironmentSnapshot[] | null | undefined;
  now?: number;
  refreshAgeMs?: number;
}): SandboxSize[] {
  return uniqueSnapshotSizes(
    (snapshots ?? [])
      .filter((snapshot) => {
        if (
          snapshot.provider !== "daytona" ||
          snapshot.status !== "ready" ||
          !snapshot.snapshotName
        ) {
          return false;
        }
        const builtAt = Date.parse(snapshot.builtAt);
        return Number.isNaN(builtAt) || now - builtAt > refreshAgeMs;
      })
      .map((snapshot) => snapshot.size),
  );
}

export function shouldReapOrphanSnapshotName({
  snapshotName,
  referencedSnapshotNames,
  now = Date.now(),
  orphanMinAgeMs = ORPHAN_MIN_AGE_MS,
}: {
  snapshotName: string;
  referencedSnapshotNames: ReadonlySet<string>;
  now?: number;
  orphanMinAgeMs?: number;
}): boolean {
  if (referencedSnapshotNames.has(snapshotName)) {
    return false;
  }
  const builtAtMs = Number(snapshotName.split("-").pop());
  return Number.isNaN(builtAtMs) || now - builtAtMs >= orphanMinAgeMs;
}

export async function scheduleEnvironmentSnapshotBuild({
  db,
  userId,
  environmentId,
  reason,
  requestedSize,
  bootSize,
  existingSnapshotSizes,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  reason: EnvironmentSnapshotScheduleReason;
  requestedSize?: SandboxSize;
  bootSize?: SandboxSize;
  existingSnapshotSizes?: readonly SandboxSize[];
}): Promise<EnvironmentSnapshotScheduleResult> {
  const plan = planEnvironmentSnapshotSchedule({
    reason,
    requestedSize,
    bootSize,
    existingSnapshotSizes,
  });

  if (plan.markExistingStale) {
    await markSnapshotsStale({ db, userId, environmentId });
  }

  for (const size of plan.sizes) {
    await triggerEnvironmentSnapshotBuild({
      db,
      userId,
      environmentId,
      size,
      force: plan.force,
      buildReason: reason,
    });
  }

  return {
    ...plan,
    scheduled: plan.sizes.length,
  };
}

export async function scheduleRepositorySnapshotRefresh({
  db,
  verifiedRepository,
  reason,
}: {
  db: DB;
  verifiedRepository: VerifiedSnapshotRepository;
  reason: Extract<EnvironmentSnapshotScheduleReason, "github-base-push">;
}): Promise<EnvironmentSnapshotScheduleResult> {
  const environments = await getEnvironmentsByRepoFullName({
    db,
    repoFullName: verifiedRepository.fullName,
  });
  let scheduled = 0;
  let sizes: SandboxSize[] = [];
  let force = false;
  for (const environment of environments) {
    const plan = await scheduleEnvironmentSnapshotBuild({
      db,
      userId: environment.userId,
      environmentId: environment.id,
      reason,
      existingSnapshotSizes: getDaytonaSnapshotSizes(environment.snapshots),
    });
    scheduled += plan.scheduled;
    sizes = uniqueSnapshotSizes([...sizes, ...plan.sizes]);
    force ||= plan.force;
  }
  return {
    sizes,
    force,
    markExistingStale: false,
    scheduled,
  };
}

export async function runEnvironmentSnapshotMaintenance({
  db,
  now = Date.now(),
}: {
  db: DB;
  now?: number;
}): Promise<EnvironmentSnapshotMaintenanceResult> {
  const environments = await getEnvironmentsWithSnapshots({ db });
  let refreshed = 0;
  for (const environment of environments) {
    const plan = await scheduleEnvironmentSnapshotBuild({
      db,
      userId: environment.userId,
      environmentId: environment.id,
      reason: "cron-stale-refresh",
      existingSnapshotSizes: getStaleReadyDaytonaSnapshotSizes({
        snapshots: environment.snapshots,
        now,
      }),
    });
    refreshed += plan.scheduled;
  }

  const referenced = new Set<string>();
  for (const environment of environments) {
    for (const snapshot of environment.snapshots ?? []) {
      if (snapshot.snapshotName) {
        referenced.add(snapshot.snapshotName);
      }
    }
  }

  const daytonaNames = await listRepoSnapshotNames();
  let reaped = 0;
  for (const name of daytonaNames) {
    if (
      !shouldReapOrphanSnapshotName({
        snapshotName: name,
        referencedSnapshotNames: referenced,
        now,
      })
    ) {
      continue;
    }
    try {
      await deleteRepoSnapshot(name);
      reaped++;
    } catch (error) {
      console.error(`[refresh-snapshots] failed to reap ${name}:`, error);
    }
  }

  return { refreshed, reaped };
}

function uniqueSnapshotSizes(sizes: readonly SandboxSize[]): SandboxSize[] {
  const out: SandboxSize[] = [];
  for (const size of sizes) {
    if (!out.includes(size)) {
      out.push(size);
    }
  }
  return out;
}
