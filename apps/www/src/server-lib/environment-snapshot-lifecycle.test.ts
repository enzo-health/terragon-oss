import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";

const waitUntilPromises: Promise<unknown>[] = [];
const getEnvironment = vi.fn();
const getReadySnapshot = vi.fn();
const hashEnvironmentVariables = vi.fn();
const hashSnapshotValue = vi.fn();
const isSnapshotBuildStale = vi.fn();
const reapStaleBuildingSnapshots = vi.fn();
const updateEnvironmentSnapshot = vi.fn();
const updateEnvironment = vi.fn();
const buildRepoSnapshot = vi.fn();
const deleteRepoSnapshot = vi.fn();
const getSetupScriptHash = vi.fn();
const getSnapshotBaseTemplateId = vi.fn();

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  },
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: { ENCRYPTION_MASTER_KEY: "test-key" },
}));

vi.mock("@terragon/shared/model/environments", () => ({
  getEnvironment: (args: unknown) => getEnvironment(args),
  getEnvironmentsByRepoFullName: vi.fn(),
  getEnvironmentsWithSnapshots: vi.fn(),
  getDecryptedEnvironmentVariables: vi.fn(),
  getDecryptedMcpConfig: vi.fn(),
  getReadySnapshot: (...args: unknown[]) => getReadySnapshot(...args),
  hashEnvironmentVariables: (args: unknown) => hashEnvironmentVariables(args),
  hashSnapshotValue: (args: unknown) => hashSnapshotValue(args),
  isSnapshotBuildStale: (...args: unknown[]) => isSnapshotBuildStale(...args),
  reapStaleBuildingSnapshots: (args: unknown) =>
    reapStaleBuildingSnapshots(args),
  updateEnvironment: (args: unknown) => updateEnvironment(args),
  updateEnvironmentSnapshot: (args: unknown) => updateEnvironmentSnapshot(args),
}));

vi.mock("@terragon/sandbox/snapshot-builder", () => ({
  buildRepoSnapshot: (args: unknown) => buildRepoSnapshot(args),
  deleteRepoSnapshot: (args: unknown) => deleteRepoSnapshot(args),
  getSetupScriptHash: (script: string | null) => getSetupScriptHash(script),
  getSnapshotBaseTemplateId: (size: string) => getSnapshotBaseTemplateId(size),
  listRepoSnapshotNames: vi.fn(),
}));

vi.mock("@/lib/github", () => ({
  getDefaultBranchForRepo: vi.fn(),
  getGitHubUserAccessToken: vi.fn(),
}));

vi.mock("@/server-lib/environment", () => ({
  getSetupScriptFromRepo: vi.fn(),
}));

import {
  buildAndStoreEnvironmentSnapshot,
  computeSnapshotRecipeFingerprint,
  maybeWarmEnvironmentSnapshot,
} from "./environment-snapshot-lifecycle";

function snapshot(
  overrides: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return {
    provider: "daytona",
    size: "small",
    snapshotName: "snapshot-1",
    status: "ready",
    setupScriptHash: "setup-hash",
    baseDockerfileHash: "base-hash",
    environmentVariablesHash: "repo-env-hash",
    mcpConfigHash: "mcp-hash",
    builtAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises.length = 0;
  getSetupScriptHash.mockImplementation((script: string | null) =>
    script ? `setup:${script}` : "",
  );
  getSnapshotBaseTemplateId.mockImplementation((size: string) => `base:${size}`);
  hashEnvironmentVariables.mockReturnValue("repo-env-hash");
  hashSnapshotValue.mockReturnValue("mcp-hash");
  deleteRepoSnapshot.mockResolvedValue(undefined);
  updateEnvironmentSnapshot.mockResolvedValue(undefined);
});

describe("computeSnapshotRecipeFingerprint", () => {
  it("fingerprints setup inputs, size, and base template", () => {
    expect(
      computeSnapshotRecipeFingerprint({
        setupScript: "pnpm install",
        size: "small",
        environmentVariables: [{ key: "API_KEY", value: "repo-value" }],
        mcpConfig: { servers: {} },
      }),
    ).toEqual({
      setupScriptHash: "setup:pnpm install",
      baseDockerfileHash: "base:small",
      environmentVariablesHash: "repo-env-hash",
      mcpConfigHash: "mcp-hash",
    });
    expect(hashEnvironmentVariables).toHaveBeenCalledWith([
      { key: "API_KEY", value: "repo-value" },
    ]);
  });
});

describe("maybeWarmEnvironmentSnapshot", () => {
  const warmParams = {
    db: {} as never,
    userId: "user-1",
    environmentId: "env-1",
    snapshots: [] as EnvironmentSnapshot[],
    repoFullName: "owner/repo",
    baseBranch: "main",
    githubAccessToken: "gh-token",
    setupScript: "pnpm install",
    size: "small" as const,
    environmentVariables: [{ key: "API_KEY", value: "repo-value" }],
    mcpConfig: { servers: {} },
  };

  it("skips when a matching ready snapshot exists and force is false", async () => {
    getReadySnapshot.mockReturnValue(snapshot());

    await maybeWarmEnvironmentSnapshot(warmParams);

    expect(reapStaleBuildingSnapshots).not.toHaveBeenCalled();
    expect(buildRepoSnapshot).not.toHaveBeenCalled();
  });

  it("reaps stale building entries before debouncing duplicate builds", async () => {
    getReadySnapshot.mockReturnValue(null);
    reapStaleBuildingSnapshots.mockResolvedValue([
      snapshot({
        status: "building",
        snapshotName: "",
        setupScriptHash: "setup:pnpm install",
        baseDockerfileHash: "base:small",
      }),
    ]);
    isSnapshotBuildStale.mockReturnValue(false);

    await maybeWarmEnvironmentSnapshot(warmParams);

    expect(reapStaleBuildingSnapshots).toHaveBeenCalledWith({
      db: {},
      environmentId: "env-1",
      userId: "user-1",
    });
    expect(buildRepoSnapshot).not.toHaveBeenCalled();
  });

  it("rebuilds when force is true even if a ready snapshot matches", async () => {
    getReadySnapshot.mockReturnValue(snapshot());
    reapStaleBuildingSnapshots.mockResolvedValue([]);
    getEnvironment.mockResolvedValue({ snapshots: [] });
    buildRepoSnapshot.mockResolvedValue({ snapshotName: "new-snapshot" });

    await maybeWarmEnvironmentSnapshot({ ...warmParams, force: true });
    await Promise.all(waitUntilPromises);

    expect(buildRepoSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: "owner/repo",
        baseBranch: "main",
        size: "small",
      }),
    );
    expect(updateEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          snapshotName: "new-snapshot",
          status: "ready",
        }),
      }),
    );
  });
});

describe("buildAndStoreEnvironmentSnapshot", () => {
  it("deletes the superseded snapshot only after the new snapshot is ready", async () => {
    getEnvironment.mockResolvedValue({
      snapshots: [snapshot({ snapshotName: "old-snapshot" })],
    });
    buildRepoSnapshot.mockResolvedValue({ snapshotName: "new-snapshot" });

    await buildAndStoreEnvironmentSnapshot({
      db: {} as never,
      userId: "user-1",
      environmentId: "env-1",
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "gh-token",
      setupScript: "pnpm install",
      size: "small",
      environmentVariables: [{ key: "API_KEY", value: "repo-value" }],
      mcpConfig: { servers: {} },
    });

    expect(deleteRepoSnapshot).not.toHaveBeenCalled();
    await Promise.all(waitUntilPromises);
    expect(deleteRepoSnapshot).toHaveBeenCalledWith("old-snapshot");
  });
});
