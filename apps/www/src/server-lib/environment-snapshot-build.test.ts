import type { DB } from "@terragon/shared/db";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const environmentMocks = vi.hoisted(() => ({
  completeEnvironmentSnapshotBuild: vi.fn(),
  getEnvironment: vi.fn(),
  getReadySnapshot: vi.fn(),
  hashEnvironmentVariables: vi.fn(),
  hashSnapshotValue: vi.fn(),
  isSnapshotBuildStale: vi.fn(),
  reapStaleBuildingSnapshots: vi.fn(),
  updateEnvironmentSnapshot: vi.fn(),
}));

const snapshotBuilderMocks = vi.hoisted(() => ({
  buildRepoSnapshot: vi.fn(),
  deleteRepoSnapshot: vi.fn(),
  getSetupScriptHash: vi.fn(),
  getSnapshotBaseTemplateId: vi.fn(),
}));

vi.mock("@terragon/shared/model/environments", () => ({
  completeEnvironmentSnapshotBuild:
    environmentMocks.completeEnvironmentSnapshotBuild,
  getEnvironment: environmentMocks.getEnvironment,
  getReadySnapshot: environmentMocks.getReadySnapshot,
  hashEnvironmentVariables: environmentMocks.hashEnvironmentVariables,
  hashSnapshotValue: environmentMocks.hashSnapshotValue,
  isSnapshotBuildStale: environmentMocks.isSnapshotBuildStale,
  reapStaleBuildingSnapshots: environmentMocks.reapStaleBuildingSnapshots,
  updateEnvironmentSnapshot: environmentMocks.updateEnvironmentSnapshot,
}));

vi.mock("@terragon/sandbox/snapshot-builder", async () => {
  const actual = await vi.importActual<
    typeof import("@terragon/sandbox/snapshot-builder")
  >("@terragon/sandbox/snapshot-builder");

  return {
    ...actual,
    buildRepoSnapshot: snapshotBuilderMocks.buildRepoSnapshot,
    deleteRepoSnapshot: snapshotBuilderMocks.deleteRepoSnapshot,
    getSetupScriptHash: snapshotBuilderMocks.getSetupScriptHash,
    getSnapshotBaseTemplateId: snapshotBuilderMocks.getSnapshotBaseTemplateId,
  };
});

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import {
  buildAndStoreEnvironmentSnapshot,
  maybeWarmEnvironmentSnapshot as maybeTriggerSnapshotBuildForBoot,
} from "./environment-snapshot-lifecycle";
import { waitUntil } from "@vercel/functions";

const TEST_DB = {} as DB;

describe("environment snapshot build safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environmentMocks.getEnvironment.mockResolvedValue({
      snapshots: [],
    });
    environmentMocks.getReadySnapshot.mockReturnValue(null);
    environmentMocks.hashEnvironmentVariables.mockReturnValue("env-hash");
    environmentMocks.hashSnapshotValue.mockReturnValue("mcp-hash");
    environmentMocks.reapStaleBuildingSnapshots.mockResolvedValue([]);
    environmentMocks.updateEnvironmentSnapshot.mockResolvedValue(undefined);
    environmentMocks.completeEnvironmentSnapshotBuild.mockResolvedValue({
      applied: true,
      currentSnapshot: null,
    });
    snapshotBuilderMocks.buildRepoSnapshot.mockResolvedValue({
      snapshotName: "repo-owner-repo-small",
    });
    snapshotBuilderMocks.getSetupScriptHash.mockReturnValue("setup-hash");
    snapshotBuilderMocks.getSnapshotBaseTemplateId.mockReturnValue("base-hash");
  });

  it("rejects manual builds before persisting status when inputs would enter image layers", async () => {
    await expect(
      buildAndStoreEnvironmentSnapshot({
        db: TEST_DB,
        userId: "user-1",
        environmentId: "env-1",
        repoFullName: "owner/repo",
        baseBranch: "main",
        githubAccessToken: "ghp_secret",
        setupScript: "echo setup",
        size: "small",
        environmentVariables: [{ key: "SECRET", value: "secret-value" }],
        mcpConfig: null,
      }),
    ).rejects.toThrow(
      "Repo snapshot build disabled for unsafe snapshot inputs: setup-script, environment-variables",
    );

    expect(environmentMocks.updateEnvironmentSnapshot).not.toHaveBeenCalled();
    expect(snapshotBuilderMocks.buildRepoSnapshot).not.toHaveBeenCalled();
  });

  it("guards successful completion with the active build id before deleting the superseded snapshot", async () => {
    environmentMocks.getEnvironment.mockResolvedValue({
      snapshots: [
        {
          provider: "daytona",
          size: "small",
          snapshotName: "old-snapshot",
          status: "ready",
          setupScriptHash: "setup-hash",
          baseDockerfileHash: "base-hash",
          environmentVariablesHash: "env-hash",
          mcpConfigHash: "mcp-hash",
          builtAt: "2026-05-31T00:00:00.000Z",
        },
      ],
    });

    await buildAndStoreEnvironmentSnapshot({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "ghp_secret",
      setupScript: null,
      size: "small",
      environmentVariables: [],
      mcpConfig: null,
    });

    const buildingSnapshot =
      environmentMocks.updateEnvironmentSnapshot.mock.calls[0]?.[0]?.snapshot;
    expect(buildingSnapshot).toEqual(
      expect.objectContaining({
        provider: "daytona",
        size: "small",
        status: "building",
        buildReason: "manual",
        requestedAt: expect.any(String),
        buildId: expect.any(String),
      }),
    );

    const buildPromise = vi.mocked(waitUntil).mock
      .calls[0]?.[0] as Promise<unknown>;
    await buildPromise;

    expect(
      environmentMocks.completeEnvironmentSnapshotBuild,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBuildId: buildingSnapshot?.buildId,
        snapshot: expect.objectContaining({
          snapshotName: "repo-owner-repo-small",
          status: "ready",
          buildId: buildingSnapshot?.buildId,
          requestedAt: buildingSnapshot?.requestedAt,
        }),
      }),
    );
    expect(snapshotBuilderMocks.deleteRepoSnapshot).toHaveBeenCalledWith(
      "old-snapshot",
    );
  });

  it("deletes a newly built snapshot when completion loses the build-id race", async () => {
    environmentMocks.getEnvironment.mockResolvedValue({
      snapshots: [
        {
          provider: "daytona",
          size: "small",
          snapshotName: "old-snapshot",
          status: "ready",
          setupScriptHash: "setup-hash",
          baseDockerfileHash: "base-hash",
          environmentVariablesHash: "env-hash",
          mcpConfigHash: "mcp-hash",
          builtAt: "2026-05-31T00:00:00.000Z",
        },
      ],
    });
    environmentMocks.completeEnvironmentSnapshotBuild.mockResolvedValue({
      applied: false,
      currentSnapshot: {
        provider: "daytona",
        size: "small",
        snapshotName: "",
        status: "building",
        buildId: "newer-build",
        setupScriptHash: "setup-hash",
        baseDockerfileHash: "base-hash",
        environmentVariablesHash: "env-hash",
        mcpConfigHash: "mcp-hash",
        builtAt: "2026-05-31T00:01:00.000Z",
      },
    });

    await buildAndStoreEnvironmentSnapshot({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "ghp_secret",
      setupScript: null,
      size: "small",
      environmentVariables: [],
      mcpConfig: null,
    });

    const buildPromise = vi.mocked(waitUntil).mock
      .calls[0]?.[0] as Promise<unknown>;
    await buildPromise;

    expect(snapshotBuilderMocks.deleteRepoSnapshot).toHaveBeenCalledOnce();
    expect(snapshotBuilderMocks.deleteRepoSnapshot).toHaveBeenCalledWith(
      "repo-owner-repo-small",
    );
  });

  it("skips boot-triggered builds when decrypted MCP config would enter image layers", async () => {
    await maybeTriggerSnapshotBuildForBoot({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
      snapshots: [],
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "ghp_secret",
      setupScript: null,
      size: "small",
      environmentVariables: [],
      mcpConfig: { mcpServers: { linear: { token: "mcp-token" } } },
    });

    expect(environmentMocks.reapStaleBuildingSnapshots).not.toHaveBeenCalled();
    expect(environmentMocks.updateEnvironmentSnapshot).not.toHaveBeenCalled();
    expect(snapshotBuilderMocks.buildRepoSnapshot).not.toHaveBeenCalled();
  });

  it("lets forced refresh supersede an older in-progress build for the same hashes", async () => {
    const buildingSnapshot = {
      provider: "daytona",
      size: "small",
      snapshotName: "",
      status: "building",
      setupScriptHash: "setup-hash",
      baseDockerfileHash: "base-hash",
      environmentVariablesHash: "env-hash",
      mcpConfigHash: "mcp-hash",
      builtAt: "2026-05-31T00:00:00.000Z",
    } satisfies EnvironmentSnapshot;
    environmentMocks.reapStaleBuildingSnapshots.mockResolvedValue([
      buildingSnapshot,
    ]);
    environmentMocks.isSnapshotBuildStale.mockReturnValue(false);

    await maybeTriggerSnapshotBuildForBoot({
      db: TEST_DB,
      userId: "user-1",
      environmentId: "env-1",
      snapshots: [buildingSnapshot],
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "ghp_secret",
      setupScript: null,
      size: "small",
      environmentVariables: [],
      mcpConfig: null,
      force: true,
      buildReason: "github-base-push",
    });

    expect(environmentMocks.updateEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          provider: "daytona",
          size: "small",
          status: "building",
          buildReason: "github-base-push",
        }),
      }),
    );
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
