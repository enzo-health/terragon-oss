import type { DB } from "@terragon/shared/db";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const environmentMocks = vi.hoisted(() => ({
  getEnvironmentsByRepoFullName: vi.fn(),
  getEnvironmentsWithSnapshots: vi.fn(),
  markSnapshotsStale: vi.fn(),
}));

const snapshotBuilderMocks = vi.hoisted(() => ({
  deleteRepoSnapshot: vi.fn(),
  listRepoSnapshotNames: vi.fn(),
}));

const triggerMocks = vi.hoisted(() => ({
  triggerEnvironmentSnapshotBuild: vi.fn(),
}));

vi.mock("@terragon/shared/model/environments", () => ({
  getEnvironmentsByRepoFullName: environmentMocks.getEnvironmentsByRepoFullName,
  getEnvironmentsWithSnapshots: environmentMocks.getEnvironmentsWithSnapshots,
  markSnapshotsStale: environmentMocks.markSnapshotsStale,
}));

vi.mock("@terragon/sandbox/snapshot-builder", () => ({
  deleteRepoSnapshot: snapshotBuilderMocks.deleteRepoSnapshot,
  listRepoSnapshotNames: snapshotBuilderMocks.listRepoSnapshotNames,
}));

vi.mock("./environment-snapshot-lifecycle", () => ({
  triggerEnvironmentSnapshotBuild: triggerMocks.triggerEnvironmentSnapshotBuild,
}));

import {
  ORPHAN_MIN_AGE_MS,
  runEnvironmentSnapshotMaintenance,
  scheduleEnvironmentSnapshotBuild,
  scheduleRepositorySnapshotRefresh,
  SNAPSHOT_REFRESH_AGE_MS,
} from "./environment-snapshot-scheduler";

const TEST_DB = {} as DB;

function snapshot(
  overrides: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return {
    provider: "daytona",
    size: "small",
    snapshotName: "repo-snapshot",
    status: "ready",
    setupScriptHash: "setup",
    baseDockerfileHash: "base",
    environmentVariablesHash: "env",
    mcpConfigHash: "mcp",
    builtAt: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("environment snapshot scheduler runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environmentMocks.markSnapshotsStale.mockResolvedValue(undefined);
    environmentMocks.getEnvironmentsByRepoFullName.mockResolvedValue([]);
    environmentMocks.getEnvironmentsWithSnapshots.mockResolvedValue([]);
    snapshotBuilderMocks.deleteRepoSnapshot.mockResolvedValue(undefined);
    snapshotBuilderMocks.listRepoSnapshotNames.mockResolvedValue([]);
    triggerMocks.triggerEnvironmentSnapshotBuild.mockResolvedValue(undefined);
  });

  it("marks existing snapshots stale before scheduling a config-change rebuild", async () => {
    const result = await scheduleEnvironmentSnapshotBuild({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
      reason: "environment-config-changed",
    });

    expect(result).toEqual({
      sizes: ["small"],
      force: false,
      markExistingStale: true,
      scheduled: 1,
    });
    expect(environmentMocks.markSnapshotsStale).toHaveBeenCalledWith({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
    });
    expect(triggerMocks.triggerEnvironmentSnapshotBuild).toHaveBeenCalledWith({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
      size: "small",
      force: false,
      buildReason: "environment-config-changed",
    });
  });

  it("schedules one forced refresh per existing Daytona size for a verified repo", async () => {
    environmentMocks.getEnvironmentsByRepoFullName.mockResolvedValue([
      {
        id: "env-1",
        userId: "user-1",
        snapshots: [
          snapshot({ size: "small" }),
          snapshot({ size: "small", status: "stale" }),
          snapshot({ size: "large" }),
        ],
      },
    ]);

    const result = await scheduleRepositorySnapshotRefresh({
      db: TEST_DB,
      verifiedRepository: {
        fullName: "owner/repo",
        defaultBranch: "main",
      },
      reason: "github-base-push",
    });

    expect(result.scheduled).toBe(2);
    expect(environmentMocks.getEnvironmentsByRepoFullName).toHaveBeenCalledWith(
      {
        db: TEST_DB,
        repoFullName: "owner/repo",
      },
    );
    expect(triggerMocks.triggerEnvironmentSnapshotBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "env-1",
        size: "small",
        force: true,
        buildReason: "github-base-push",
      }),
    );
    expect(triggerMocks.triggerEnvironmentSnapshotBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "env-1",
        size: "large",
        force: true,
        buildReason: "github-base-push",
      }),
    );
  });

  it("refreshes stale snapshots and reaps only unreferenced old Daytona snapshots", async () => {
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    environmentMocks.getEnvironmentsWithSnapshots.mockResolvedValue([
      {
        id: "env-1",
        userId: "user-1",
        snapshots: [
          snapshot({
            size: "small",
            snapshotName: "repo-current",
            builtAt: new Date(now - SNAPSHOT_REFRESH_AGE_MS - 1).toISOString(),
          }),
          snapshot({
            size: "large",
            snapshotName: "repo-fresh",
            builtAt: new Date(now - SNAPSHOT_REFRESH_AGE_MS + 1).toISOString(),
          }),
        ],
      },
    ]);
    snapshotBuilderMocks.listRepoSnapshotNames.mockResolvedValue([
      "repo-current",
      `repo-new-${now - ORPHAN_MIN_AGE_MS + 1}`,
      `repo-old-${now - ORPHAN_MIN_AGE_MS}`,
    ]);

    const result = await runEnvironmentSnapshotMaintenance({
      db: TEST_DB,
      now,
    });

    expect(result).toEqual({ refreshed: 1, reaped: 1 });
    expect(triggerMocks.triggerEnvironmentSnapshotBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "env-1",
        size: "small",
        force: true,
        buildReason: "cron-stale-refresh",
      }),
    );
    expect(snapshotBuilderMocks.deleteRepoSnapshot).toHaveBeenCalledOnce();
    expect(snapshotBuilderMocks.deleteRepoSnapshot).toHaveBeenCalledWith(
      `repo-old-${now - ORPHAN_MIN_AGE_MS}`,
    );
  });
});
