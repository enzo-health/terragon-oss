import { describe, expect, it } from "vitest";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import {
  getDaytonaSnapshotSizes,
  getStaleReadyDaytonaSnapshotSizes,
  ORPHAN_MIN_AGE_MS,
  planEnvironmentSnapshotSchedule,
  shouldReapOrphanSnapshotName,
  SNAPSHOT_REFRESH_AGE_MS,
} from "./environment-snapshot-scheduler";

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

describe("environment snapshot scheduler policy", () => {
  it("maps scheduling reasons to size, force, and stale-mark policy", () => {
    expect(
      planEnvironmentSnapshotSchedule({
        reason: "manual",
        requestedSize: "large",
      }),
    ).toEqual({
      sizes: ["large"],
      force: true,
      markExistingStale: false,
    });
    expect(
      planEnvironmentSnapshotSchedule({ reason: "environment-config-changed" }),
    ).toEqual({
      sizes: ["small"],
      force: false,
      markExistingStale: true,
    });
    expect(
      planEnvironmentSnapshotSchedule({
        reason: "boot-miss",
        bootSize: "large",
      }),
    ).toEqual({
      sizes: ["large"],
      force: false,
      markExistingStale: false,
    });
    expect(
      planEnvironmentSnapshotSchedule({
        reason: "snapshot-refresh-failed",
        bootSize: "large",
      }),
    ).toEqual({
      sizes: ["large"],
      force: true,
      markExistingStale: false,
    });
  });

  it("refreshes every existing Daytona size exactly once for base-branch pushes", () => {
    expect(
      planEnvironmentSnapshotSchedule({
        reason: "github-base-push",
        existingSnapshotSizes: ["small", "small", "large"],
      }),
    ).toEqual({
      sizes: ["small", "large"],
      force: true,
      markExistingStale: false,
    });
  });

  it("selects stale ready Daytona snapshots for cron refresh", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");

    expect(
      getStaleReadyDaytonaSnapshotSizes({
        now,
        snapshots: [
          snapshot({
            size: "small",
            builtAt: new Date(now - SNAPSHOT_REFRESH_AGE_MS - 1).toISOString(),
          }),
          snapshot({
            size: "large",
            builtAt: new Date(now - SNAPSHOT_REFRESH_AGE_MS + 1).toISOString(),
          }),
          snapshot({ size: "small", status: "failed" }),
        ],
      }),
    ).toEqual(["small"]);
  });

  it("returns distinct existing Daytona snapshot sizes", () => {
    expect(
      getDaytonaSnapshotSizes([
        snapshot({ size: "small" }),
        snapshot({ size: "small", status: "stale" }),
        snapshot({ size: "large" }),
      ]),
    ).toEqual(["small", "large"]);
  });

  it("skips referenced and too-new orphan snapshot names", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const referencedSnapshotNames = new Set(["repo-current"]);

    expect(
      shouldReapOrphanSnapshotName({
        snapshotName: "repo-current",
        referencedSnapshotNames,
        now,
      }),
    ).toBe(false);
    expect(
      shouldReapOrphanSnapshotName({
        snapshotName: `repo-new-${now - ORPHAN_MIN_AGE_MS + 1}`,
        referencedSnapshotNames,
        now,
      }),
    ).toBe(false);
    expect(
      shouldReapOrphanSnapshotName({
        snapshotName: `repo-old-${now - ORPHAN_MIN_AGE_MS}`,
        referencedSnapshotNames,
        now,
      }),
    ).toBe(true);
  });
});
