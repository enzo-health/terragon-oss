import { waitUntil } from "@vercel/functions";
import type { DB } from "@terragon/shared/db";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";
import {
  getReadySnapshot,
  hashEnvironmentVariables,
  hashSnapshotValue,
  isSnapshotBuildStale,
  reapStaleBuildingSnapshots,
  updateEnvironmentSnapshot,
} from "@terragon/shared/model/environments";
import {
  buildRepoSnapshot,
  getSetupScriptHash,
  getSnapshotBaseTemplateId,
} from "@terragon/sandbox/snapshot-builder";

type SnapshotHashes = {
  setupScriptHash: string;
  baseDockerfileHash: string;
  environmentVariablesHash: string;
  mcpConfigHash: string;
};

function computeSnapshotHashes({
  setupScript,
  size,
  environmentVariables,
  mcpConfig,
}: {
  setupScript: string | null;
  size: SandboxSize;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig: unknown;
}): SnapshotHashes {
  return {
    setupScriptHash: getSetupScriptHash(setupScript),
    baseDockerfileHash: getSnapshotBaseTemplateId(size),
    environmentVariablesHash: hashEnvironmentVariables(environmentVariables),
    mcpConfigHash: hashSnapshotValue(mcpConfig),
  };
}

/**
 * Build a Daytona repo snapshot and persist its lifecycle (`building` →
 * `ready`/`failed`) on the environment. The Daytona build runs under
 * `waitUntil` so it survives the request returning. Shared by the Settings
 * action and the boot-time auto-build path so the lifecycle logic lives in one
 * place.
 */
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
  const hashes = computeSnapshotHashes({
    setupScript,
    size,
    environmentVariables,
    mcpConfig,
  });

  await updateEnvironmentSnapshot({
    db,
    environmentId,
    userId,
    snapshot: {
      provider: "daytona",
      size,
      snapshotName: "",
      status: "building",
      ...hashes,
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
            snapshotName,
            status: "ready",
            ...hashes,
            builtAt: new Date().toISOString(),
          },
        });
        console.log(
          `[snapshot-build] Snapshot ready: ${snapshotName} for ${repoFullName}`,
        );
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
            snapshotName: "",
            status: "failed",
            ...hashes,
            error: error instanceof Error ? error.message : String(error),
            builtAt: new Date().toISOString(),
          },
        }).catch((e) =>
          console.error("[snapshot-build] Failed to update status:", e),
        );
      }),
  );
}

/**
 * Boot-time auto-build: when a Daytona task boots and there is no ready
 * snapshot matching the current size + config hashes, kick a background build
 * so the *next* task on this repo skips the setup script. Reaps stale
 * `building` entries first, and debounces against a genuinely in-progress build
 * so concurrent boots don't stack duplicate builds. Fire-and-forget — never
 * blocks or fails the boot.
 */
export async function maybeTriggerSnapshotBuildForBoot({
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
}): Promise<void> {
  try {
    const hashes = computeSnapshotHashes({
      setupScript,
      size,
      environmentVariables,
      mcpConfig,
    });

    // A ready snapshot already covers this exact config — nothing to do.
    if (getReadySnapshot({ snapshots }, "daytona", size, hashes)) {
      return;
    }

    // Flip dead `building` entries so they don't mask the need for a rebuild.
    const reaped = await reapStaleBuildingSnapshots({
      db,
      environmentId,
      userId,
    });

    // Debounce: a genuinely in-progress build for this size/config is enough.
    const now = Date.now();
    const inProgress = reaped.some(
      (s) =>
        s.provider === "daytona" &&
        s.size === size &&
        s.status === "building" &&
        s.setupScriptHash === hashes.setupScriptHash &&
        s.baseDockerfileHash === hashes.baseDockerfileHash &&
        s.environmentVariablesHash === hashes.environmentVariablesHash &&
        s.mcpConfigHash === hashes.mcpConfigHash &&
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
