import { waitUntil } from "@vercel/functions";
import type { DB } from "@terragon/shared/db";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";
import { env } from "@terragon/env/apps-www";
import {
  getEnvironment,
  getEnvironmentsByRepoFullName,
  getEnvironmentsWithSnapshots,
  getDecryptedEnvironmentVariables,
  getDecryptedMcpConfig,
  getReadySnapshot,
  hashEnvironmentVariables,
  hashSnapshotValue,
  isSnapshotBuildStale,
  reapStaleBuildingSnapshots,
  updateEnvironment,
  updateEnvironmentSnapshot,
} from "@terragon/shared/model/environments";
import {
  buildRepoSnapshot,
  deleteRepoSnapshot,
  getSetupScriptHash,
  getSnapshotBaseTemplateId,
  listRepoSnapshotNames,
} from "@terragon/sandbox/snapshot-builder";
import {
  getDefaultBranchForRepo,
  getGitHubUserAccessToken,
} from "@/lib/github";
import { DEFAULT_SANDBOX_SIZE } from "@/lib/subscription-tiers";
import { getSetupScriptFromRepo } from "@/server-lib/environment";

const SNAPSHOT_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export type SnapshotRecipeFingerprint = {
  setupScriptHash: string;
  baseDockerfileHash: string;
  environmentVariablesHash: string;
  mcpConfigHash: string;
};

export type SnapshotBuildInputFailure =
  | "environment-not-found"
  | "not-repo-environment"
  | "missing-github-token";

export type SnapshotBuildInputs = {
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  setupScript: string | null;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig: unknown;
  snapshots: EnvironmentSnapshot[] | null;
};

export type SnapshotBuildInputsResult =
  | { ok: true; inputs: SnapshotBuildInputs }
  | { ok: false; failure: SnapshotBuildInputFailure };

export function computeSnapshotRecipeFingerprint({
  setupScript,
  size,
  environmentVariables,
  mcpConfig,
}: {
  setupScript: string | null;
  size: SandboxSize;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig: unknown;
}): SnapshotRecipeFingerprint {
  return {
    setupScriptHash: getSetupScriptHash(setupScript),
    baseDockerfileHash: getSnapshotBaseTemplateId(size),
    environmentVariablesHash: hashEnvironmentVariables(environmentVariables),
    mcpConfigHash: hashSnapshotValue(mcpConfig),
  };
}

export function buildSnapshotRecipeFingerprint({
  setupScript,
  size,
  environmentVariablesHash,
  mcpConfigHash,
}: {
  setupScript: string | null;
  size: SandboxSize;
  environmentVariablesHash: string;
  mcpConfigHash: string;
}): SnapshotRecipeFingerprint {
  return {
    setupScriptHash: getSetupScriptHash(setupScript),
    baseDockerfileHash: getSnapshotBaseTemplateId(size),
    environmentVariablesHash,
    mcpConfigHash,
  };
}

export function selectReadyEnvironmentSnapshot({
  snapshots,
  size,
  baseBranch,
  fingerprint,
}: {
  snapshots: EnvironmentSnapshot[] | null;
  size: SandboxSize;
  baseBranch: string;
  fingerprint: SnapshotRecipeFingerprint;
}): EnvironmentSnapshot | null {
  return getReadySnapshot({ snapshots }, "daytona", size, {
    baseBranch,
    ...fingerprint,
  });
}

export async function loadSnapshotBuildInputs({
  db,
  userId,
  environmentId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
}): Promise<SnapshotBuildInputsResult> {
  const environment = await getEnvironment({ db, environmentId, userId });
  if (!environment) {
    return { ok: false, failure: "environment-not-found" };
  }
  if (environment.isGlobal || !environment.repoFullName) {
    return { ok: false, failure: "not-repo-environment" };
  }

  const githubAccessToken = await getGitHubUserAccessToken({ userId });
  if (!githubAccessToken) {
    return { ok: false, failure: "missing-github-token" };
  }

  const setupScript =
    environment.setupScript ??
    (await getSetupScriptFromRepo({ db, userId, environmentId }));

  const [environmentVariables, mcpConfig, baseBranch] = await Promise.all([
    getDecryptedEnvironmentVariables({
      db,
      userId,
      environmentId,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    getDecryptedMcpConfig({
      db,
      userId,
      environmentId,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    getDefaultBranchForRepo({ userId, repoFullName: environment.repoFullName }),
  ]);

  return {
    ok: true,
    inputs: {
      repoFullName: environment.repoFullName,
      baseBranch,
      githubAccessToken,
      setupScript,
      environmentVariables,
      mcpConfig,
      snapshots: environment.snapshots ?? null,
    },
  };
}

export async function buildAndStoreEnvironmentSnapshot({
  db,
  userId,
  environmentId,
  repoFullName,
  baseBranch,
  githubAccessToken,
  setupScript,
  size,
  environmentVariables,
  mcpConfig,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  setupScript: string | null;
  size: SandboxSize;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig: unknown;
}): Promise<void> {
  const fingerprint = computeSnapshotRecipeFingerprint({
    setupScript,
    size,
    environmentVariables,
    mcpConfig,
  });

  const existing = await getEnvironment({ db, environmentId, userId });
  const previousSnapshotName =
    existing?.snapshots?.find(
      (s) =>
        s.provider === "daytona" &&
        s.size === size &&
        s.baseBranch === baseBranch,
    )?.snapshotName || null;

  await updateEnvironmentSnapshot({
    db,
    environmentId,
    userId,
    snapshot: {
      provider: "daytona",
      size,
      baseBranch,
      snapshotName: "",
      status: "building",
      ...fingerprint,
      builtAt: new Date().toISOString(),
    },
  });

  waitUntil(
    buildRepoSnapshot({
      repoFullName,
      baseBranch,
      githubAccessToken,
      setupScript,
      environmentVariables,
      size,
      onLogs: (chunk) => console.log(`[snapshot-build] ${chunk}`),
    })
      .then(async ({ snapshotName }) => {
        await updateEnvironmentSnapshot({
          db,
          environmentId,
          userId,
          snapshot: {
            provider: "daytona",
            size,
            baseBranch,
            snapshotName,
            status: "ready",
            ...fingerprint,
            builtAt: new Date().toISOString(),
          },
        });
        console.log(
          `[snapshot-build] Snapshot ready: ${snapshotName} for ${repoFullName}`,
        );
        if (previousSnapshotName && previousSnapshotName !== snapshotName) {
          await deleteRepoSnapshot(previousSnapshotName).catch((error) =>
            console.error(
              `[snapshot-build] Failed to delete superseded snapshot ${previousSnapshotName}:`,
              error,
            ),
          );
        }
      })
      .catch(async (error) => {
        console.error(`[snapshot-build] Failed:`, error);
        await updateEnvironmentSnapshot({
          db,
          environmentId,
          userId,
          snapshot: {
            provider: "daytona",
            size,
            baseBranch,
            snapshotName: "",
            status: "failed",
            ...fingerprint,
            error: error instanceof Error ? error.message : String(error),
            builtAt: new Date().toISOString(),
          },
        }).catch((e) =>
          console.error("[snapshot-build] Failed to update status:", e),
        );
      }),
  );
}

export async function buildEnvironmentSnapshotNow({
  db,
  userId,
  environmentId,
  size,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  size: SandboxSize;
}): Promise<SnapshotBuildInputsResult> {
  const result = await loadSnapshotBuildInputs({ db, userId, environmentId });
  if (!result.ok) {
    return result;
  }
  await buildAndStoreEnvironmentSnapshot({
    db,
    userId,
    environmentId,
    ...result.inputs,
    size,
  });
  return result;
}

export async function maybeWarmEnvironmentSnapshot({
  db,
  userId,
  environmentId,
  snapshots,
  repoFullName,
  baseBranch,
  githubAccessToken,
  setupScript,
  size,
  environmentVariables,
  mcpConfig,
  force = false,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  snapshots: EnvironmentSnapshot[] | null;
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  setupScript: string | null;
  size: SandboxSize;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig: unknown;
  force?: boolean;
}): Promise<void> {
  try {
    const fingerprint = computeSnapshotRecipeFingerprint({
      setupScript,
      size,
      environmentVariables,
      mcpConfig,
    });

    if (
      !force &&
      selectReadyEnvironmentSnapshot({
        snapshots,
        size,
        baseBranch,
        fingerprint,
      })
    ) {
      return;
    }

    const reaped = await reapStaleBuildingSnapshots({
      db,
      environmentId,
      userId,
    });

    const now = Date.now();
    const inProgress = reaped.some(
      (s) =>
        s.provider === "daytona" &&
        s.size === size &&
        s.baseBranch === baseBranch &&
        s.status === "building" &&
        s.setupScriptHash === fingerprint.setupScriptHash &&
        s.baseDockerfileHash === fingerprint.baseDockerfileHash &&
        s.environmentVariablesHash === fingerprint.environmentVariablesHash &&
        s.mcpConfigHash === fingerprint.mcpConfigHash &&
        !isSnapshotBuildStale(s, now),
    );
    if (inProgress) {
      return;
    }

    await buildAndStoreEnvironmentSnapshot({
      db,
      userId,
      environmentId,
      repoFullName,
      baseBranch,
      githubAccessToken,
      setupScript,
      size,
      environmentVariables,
      mcpConfig,
    });
  } catch (error) {
    console.warn("[snapshot-build] auto-build trigger skipped:", error);
  }
}

export async function triggerEnvironmentSnapshotBuild({
  db,
  userId,
  environmentId,
  baseBranch,
  size = DEFAULT_SANDBOX_SIZE,
  force = false,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  baseBranch?: string;
  size?: SandboxSize;
  force?: boolean;
}): Promise<void> {
  try {
    const result = await loadSnapshotBuildInputs({ db, userId, environmentId });
    if (!result.ok) {
      return;
    }
    await maybeWarmEnvironmentSnapshot({
      db,
      userId,
      environmentId,
      snapshots: result.inputs.snapshots,
      repoFullName: result.inputs.repoFullName,
      baseBranch: baseBranch ?? result.inputs.baseBranch,
      githubAccessToken: result.inputs.githubAccessToken,
      setupScript: result.inputs.setupScript,
      size,
      environmentVariables: result.inputs.environmentVariables,
      mcpConfig: result.inputs.mcpConfig,
      force,
    });
  } catch (error) {
    console.warn(
      `[snapshot-build] eager trigger skipped for ${environmentId}:`,
      error,
    );
  }
}

export async function deleteEnvironmentSnapshotForSize({
  db,
  userId,
  environmentId,
  size,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  size: SandboxSize;
}): Promise<SnapshotBuildInputFailure | "deleted"> {
  const environment = await getEnvironment({ db, environmentId, userId });
  if (!environment) {
    return "environment-not-found";
  }

  const snapshot = getReadySnapshot(environment, "daytona", size);
  if (snapshot?.snapshotName) {
    try {
      await deleteRepoSnapshot(snapshot.snapshotName);
    } catch (error) {
      console.error(`[snapshot-delete] Failed to delete from Daytona:`, error);
    }
  }

  const existing = environment.snapshots ?? [];
  const updated = existing.filter(
    (s) => !(s.provider === "daytona" && s.size === size),
  );
  await updateEnvironment({
    db,
    userId,
    environmentId,
    updates: { snapshots: updated },
  });
  return "deleted";
}

export async function refreshEnvironmentSnapshotsForRepo({
  db,
  repoFullName,
  baseBranch,
  includeLegacyBranchless = false,
}: {
  db: DB;
  repoFullName: string;
  baseBranch: string;
  includeLegacyBranchless?: boolean;
}): Promise<number> {
  const environments = await getEnvironmentsByRepoFullName({
    db,
    repoFullName,
  });
  let triggered = 0;

  for (const environment of environments) {
    const sizes = new Set<SandboxSize>();
    for (const snapshot of environment.snapshots ?? []) {
      if (
        snapshot.provider === "daytona" &&
        (snapshot.baseBranch === baseBranch ||
          (includeLegacyBranchless && !snapshot.baseBranch))
      ) {
        sizes.add(snapshot.size);
      }
    }
    for (const size of sizes) {
      waitUntil(
        triggerEnvironmentSnapshotBuild({
          db,
          userId: environment.userId,
          environmentId: environment.id,
          baseBranch,
          size,
          force: true,
        }),
      );
      triggered++;
    }
  }

  return triggered;
}

export async function refreshStaleEnvironmentSnapshots({
  db,
  now = Date.now(),
}: {
  db: DB;
  now?: number;
}): Promise<number> {
  const environments = await getEnvironmentsWithSnapshots({ db });
  let refreshed = 0;
  for (const environment of environments) {
    const snapshotsToRefresh = new Map<string, EnvironmentSnapshot>();
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
        const key = `${snapshot.size}:${snapshot.baseBranch ?? ""}`;
        snapshotsToRefresh.set(key, snapshot);
      }
    }
    for (const snapshot of snapshotsToRefresh.values()) {
      await triggerEnvironmentSnapshotBuild({
        db,
        userId: environment.userId,
        environmentId: environment.id,
        baseBranch: snapshot.baseBranch,
        size: snapshot.size,
        force: true,
      });
      refreshed++;
    }
  }
  return refreshed;
}

export async function reapOrphanEnvironmentSnapshots({
  db,
  now = Date.now(),
}: {
  db: DB;
  now?: number;
}): Promise<number> {
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
  let reaped = 0;
  for (const name of daytonaNames) {
    if (referenced.has(name)) {
      continue;
    }
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
