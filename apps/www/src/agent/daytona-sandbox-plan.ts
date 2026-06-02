import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import {
  getDaytonaVolumeEnvironmentEntries,
  resolveDaytonaVolumeLayout,
  type DaytonaVolumeLayout,
} from "@terragon/sandbox/daytona-volume";
import {
  buildSnapshotRecipeFingerprint,
  selectReadyEnvironmentSnapshot,
  type SnapshotRecipeFingerprint,
} from "@/server-lib/environment-snapshot-lifecycle";

export type DaytonaSandboxBootPlan = {
  daytonaVolume: DaytonaVolumeLayout | undefined;
  volumeEnvironmentEntries: Array<{ key: string; value: string }>;
  snapshotTemplateId: string | undefined;
  snapshotFingerprint: SnapshotRecipeFingerprint | undefined;
};

export function resolveDaytonaSandboxBootPlan({
  sandboxProvider,
  existingSandboxId,
  userId,
  environmentId,
  threadId,
  repoFullName,
  volumeEnabled,
  volumeName,
  sandboxSize,
  baseBranch,
  setupScript,
  snapshots,
  environmentVariablesHash,
  mcpConfigHash,
}: {
  sandboxProvider: SandboxProvider;
  existingSandboxId: string | null;
  userId: string;
  environmentId: string | null;
  threadId: string;
  repoFullName: string | null;
  volumeEnabled: boolean;
  volumeName: string;
  sandboxSize: SandboxSize;
  baseBranch: string;
  setupScript: string | null;
  snapshots: EnvironmentSnapshot[] | null;
  environmentVariablesHash: string;
  mcpConfigHash: string;
}): DaytonaSandboxBootPlan {
  if (sandboxProvider !== "daytona" || !environmentId) {
    return {
      daytonaVolume: undefined,
      volumeEnvironmentEntries: [],
      snapshotTemplateId: undefined,
      snapshotFingerprint: undefined,
    };
  }

  const daytonaVolume = resolveDaytonaVolumeLayout({
    userId,
    environmentId,
    threadId,
    repoFullName,
    volumeEnabled,
    volumeName,
  });

  const snapshotFingerprint = buildSnapshotRecipeFingerprint({
    setupScript,
    size: sandboxSize,
    environmentVariablesHash,
    mcpConfigHash,
  });
  const snapshot =
    existingSandboxId === null
      ? selectReadyEnvironmentSnapshot({
          snapshots,
          size: sandboxSize,
          baseBranch,
          fingerprint: snapshotFingerprint,
        })
      : null;

  return {
    daytonaVolume,
    volumeEnvironmentEntries: getDaytonaVolumeEnvironmentEntries(daytonaVolume),
    snapshotTemplateId: snapshot?.snapshotName ?? undefined,
    snapshotFingerprint,
  };
}
