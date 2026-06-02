import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";

const waitUntilPromises: Promise<unknown>[] = [];
const getEnvironment = vi.fn();
const getEnvironmentsByRepoFullName = vi.fn();
const getEnvironmentsWithSnapshots = vi.fn();
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
const getDefaultBranchForRepo = vi.fn();
const getGitHubUserAccessToken = vi.fn();
const getSetupScriptFromRepo = vi.fn();
const getDecryptedEnvironmentVariables = vi.fn();
const getDecryptedMcpConfig = vi.fn();

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
  getEnvironmentsByRepoFullName: (args: unknown) =>
    getEnvironmentsByRepoFullName(args),
  getEnvironmentsWithSnapshots: (args: unknown) =>
    getEnvironmentsWithSnapshots(args),
  getDecryptedEnvironmentVariables: (args: unknown) =>
    getDecryptedEnvironmentVariables(args),
  getDecryptedMcpConfig: (args: unknown) => getDecryptedMcpConfig(args),
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
  getDefaultBranchForRepo: (args: unknown) => getDefaultBranchForRepo(args),
  getGitHubUserAccessToken: (args: unknown) => getGitHubUserAccessToken(args),
}));

vi.mock("@/server-lib/environment", () => ({
  getSetupScriptFromRepo: (args: unknown) => getSetupScriptFromRepo(args),
}));

import {
  buildAndStoreEnvironmentSnapshot,
  computeSnapshotRecipeFingerprint,
  maybeWarmEnvironmentSnapshot,
  refreshEnvironmentSnapshotsForRepo,
  refreshStaleEnvironmentSnapshots,
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
  getSnapshotBaseTemplateId.mockImplementation(
    (size: string) => `base:${size}`,
  );
  hashEnvironmentVariables.mockReturnValue("repo-env-hash");
  hashSnapshotValue.mockReturnValue("mcp-hash");
  deleteRepoSnapshot.mockResolvedValue(undefined);
  updateEnvironmentSnapshot.mockResolvedValue(undefined);
  getGitHubUserAccessToken.mockResolvedValue("gh-token");
  getDefaultBranchForRepo.mockResolvedValue("main");
  getSetupScriptFromRepo.mockResolvedValue("pnpm install");
  getDecryptedEnvironmentVariables.mockResolvedValue([
    { key: "API_KEY", value: "repo-value" },
  ]);
  getDecryptedMcpConfig.mockResolvedValue({ servers: {} });
  buildRepoSnapshot.mockResolvedValue({ snapshotName: "new-snapshot" });
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
        baseBranch: "main",
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
      snapshots: [
        snapshot({ baseBranch: "main", snapshotName: "old-snapshot" }),
      ],
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

  it("deletes a superseded legacy branchless snapshot for default-branch builds", async () => {
    getEnvironment.mockResolvedValue({
      snapshots: [
        snapshot({ baseBranch: undefined, snapshotName: "legacy-snapshot" }),
      ],
    });

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

    await Promise.all(waitUntilPromises);
    expect(deleteRepoSnapshot).toHaveBeenCalledWith("legacy-snapshot");
  });
});

describe("refreshEnvironmentSnapshotsForRepo", () => {
  it("refreshes only snapshots for the pushed branch unless legacy snapshots are explicitly included", async () => {
    getEnvironment.mockResolvedValue({
      isGlobal: false,
      repoFullName: "owner/repo",
      setupScript: "pnpm install",
      snapshots: [],
    });
    getEnvironmentsByRepoFullName.mockResolvedValue([
      {
        id: "env-1",
        userId: "user-1",
        snapshots: [
          snapshot({ baseBranch: "feature/foo", size: "small" }),
          snapshot({ baseBranch: "main", size: "large" }),
          snapshot({ baseBranch: undefined, size: "small" }),
        ],
      },
    ]);

    const refreshed = await refreshEnvironmentSnapshotsForRepo({
      db: {} as never,
      repoFullName: "owner/repo",
      baseBranch: "feature/foo",
    });

    expect(refreshed).toBe(1);
    await Promise.all(waitUntilPromises);
    expect(buildRepoSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "feature/foo",
        size: "small",
      }),
    );
  });

  it("includes legacy branchless snapshots for default branch refreshes", async () => {
    getEnvironment.mockResolvedValue({
      isGlobal: false,
      repoFullName: "owner/repo",
      setupScript: "pnpm install",
      snapshots: [],
    });
    getEnvironmentsByRepoFullName.mockResolvedValue([
      {
        id: "env-1",
        userId: "user-1",
        snapshots: [
          snapshot({ baseBranch: undefined, size: "small" }),
          snapshot({ baseBranch: "main", size: "large" }),
        ],
      },
    ]);

    const refreshed = await refreshEnvironmentSnapshotsForRepo({
      db: {} as never,
      repoFullName: "owner/repo",
      baseBranch: "main",
      includeLegacyBranchless: true,
    });

    expect(refreshed).toBe(2);
    await Promise.all(waitUntilPromises);
    expect(buildRepoSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main", size: "small" }),
    );
    expect(buildRepoSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main", size: "large" }),
    );
  });
});

describe("refreshStaleEnvironmentSnapshots", () => {
  it("preserves base branch when refreshing stale snapshots", async () => {
    const now = Date.parse("2026-06-02T00:00:00.000Z");
    getEnvironment.mockResolvedValue({
      isGlobal: false,
      repoFullName: "owner/repo",
      setupScript: "pnpm install",
      snapshots: [],
    });
    getEnvironmentsWithSnapshots.mockResolvedValue([
      {
        id: "env-1",
        userId: "user-1",
        snapshots: [
          snapshot({
            baseBranch: "feature/foo",
            builtAt: "2026-05-30T00:00:00.000Z",
          }),
          snapshot({
            baseBranch: "main",
            size: "large",
            builtAt: "2026-05-30T00:00:00.000Z",
          }),
        ],
      },
    ]);

    const refreshed = await refreshStaleEnvironmentSnapshots({
      db: {} as never,
      now,
    });

    expect(refreshed).toBe(2);
    expect(buildRepoSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "feature/foo",
        size: "small",
      }),
    );
    expect(buildRepoSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "main",
        size: "large",
      }),
    );
  });
});
