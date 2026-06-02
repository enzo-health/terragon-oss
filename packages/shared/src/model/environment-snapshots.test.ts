import { describe, expect, it } from "vitest";
import type { EnvironmentSnapshot } from "../db/schema";
import {
  applyEnvironmentSnapshotUpdate,
  getReadySnapshot,
} from "./environments";

function buildSnapshot(
  overrides: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return {
    provider: "daytona",
    size: "large",
    snapshotName: "repo-snapshot",
    status: "ready",
    baseBranch: "main",
    setupScriptHash: "setup-hash",
    baseDockerfileHash: "base-hash",
    environmentVariablesHash: "env-hash",
    mcpConfigHash: "mcp-hash",
    builtAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("environment snapshot selection", () => {
  it("only resolves ready snapshots for the requested base branch", () => {
    const mainSnapshot = buildSnapshot({
      snapshotName: "repo-main",
      baseBranch: "main",
    });
    const featureSnapshot = buildSnapshot({
      snapshotName: "repo-feature",
      baseBranch: "feature/foo",
    });
    const legacySnapshot = buildSnapshot({
      snapshotName: "repo-legacy",
      baseBranch: undefined,
    });

    expect(
      getReadySnapshot(
        { snapshots: [mainSnapshot, featureSnapshot, legacySnapshot] },
        "daytona",
        "large",
        { baseBranch: "feature/foo" },
      )?.snapshotName,
    ).toBe("repo-feature");
    expect(
      getReadySnapshot(
        { snapshots: [mainSnapshot, legacySnapshot] },
        "daytona",
        "large",
        { baseBranch: "feature/foo" },
      ),
    ).toBeNull();
  });

  it("prefers exact branch snapshots before legacy branchless fallback", () => {
    const exactSnapshot = buildSnapshot({
      snapshotName: "repo-main",
      baseBranch: "main",
    });
    const legacySnapshot = buildSnapshot({
      snapshotName: "repo-legacy",
      baseBranch: undefined,
    });

    expect(
      getReadySnapshot(
        { snapshots: [legacySnapshot, exactSnapshot] },
        "daytona",
        "large",
        { baseBranch: "main", includeLegacyBranchless: true },
      )?.snapshotName,
    ).toBe("repo-main");
    expect(
      getReadySnapshot({ snapshots: [legacySnapshot] }, "daytona", "large", {
        baseBranch: "main",
        includeLegacyBranchless: true,
      })?.snapshotName,
    ).toBe("repo-legacy");
    expect(
      getReadySnapshot({ snapshots: [legacySnapshot] }, "daytona", "large", {
        baseBranch: "feature/foo",
      }),
    ).toBeNull();
  });

  it("stores same-size snapshots independently per base branch", () => {
    const withMainV1 = applyEnvironmentSnapshotUpdate(
      null,
      buildSnapshot({
        snapshotName: "repo-main-v1",
        baseBranch: "main",
      }),
    );
    const withFeature = applyEnvironmentSnapshotUpdate(
      withMainV1,
      buildSnapshot({
        snapshotName: "repo-feature",
        baseBranch: "feature/foo",
      }),
    );
    const updated = applyEnvironmentSnapshotUpdate(
      withFeature,
      buildSnapshot({
        snapshotName: "repo-main-v2",
        baseBranch: "main",
      }),
    );

    expect(updated).toHaveLength(2);
    expect(
      getReadySnapshot({ snapshots: updated }, "daytona", "large", {
        baseBranch: "main",
      })?.snapshotName,
    ).toBe("repo-main-v2");
    expect(
      getReadySnapshot({ snapshots: updated }, "daytona", "large", {
        baseBranch: "feature/foo",
      })?.snapshotName,
    ).toBe("repo-feature");
  });
});
