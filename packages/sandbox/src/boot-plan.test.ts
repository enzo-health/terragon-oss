import { describe, expect, it } from "vitest";
import {
  buildBootPlan,
  buildSandboxBootRecipe,
  type BootPlan,
} from "./boot-plan";
import type { CreateSandboxOptions } from "./types";

const defaultOptions: CreateSandboxOptions = {
  threadName: "test-title",
  userName: "test-user",
  userEmail: "test@example.com",
  githubAccessToken: "test-token",
  githubRepoFullName: "owner/repo",
  repoBaseBranchName: "main",
  userId: "user-123",
  sandboxSize: "small",
  sandboxProvider: "docker",
  createNewBranch: true,
  environmentVariables: [],
  agentCredentials: null,
  autoUpdateDaemon: false,
  publicUrl: "http://localhost:3000",
  featureFlags: {},
  generateBranchName: async () => null,
  onStatusUpdate: async () => {},
  agent: null,
};

function buildPlan(
  overrides: Partial<CreateSandboxOptions> = {},
  isCreatingSandbox = true,
): BootPlan {
  return buildBootPlan({
    options: {
      ...defaultOptions,
      ...overrides,
    },
    isCreatingSandbox,
  });
}

describe("buildBootPlan", () => {
  it("plans a fresh sandbox boot from a repository clone", () => {
    expect(buildPlan()).toEqual({
      shouldCloneRepo: true,
      shouldRefreshSnapshotRepo: false,
      branchAction: { type: "create" },
      setupScriptMode: "foreground",
      shouldProbeSandboxAgent: true,
      shouldUpdateAgentFiles: false,
      agentToUpdate: null,
      shouldRestartDaemon: false,
      shouldUpdateDaemonBeforeRestart: false,
    });
  });

  it("plans snapshot boots without clone or setup script", () => {
    expect(
      buildPlan({
        snapshotTemplateId: "repo-owner-repo-small-123",
        backgroundSetupScript: true,
        skipSetupScript: false,
      }),
    ).toMatchObject({
      shouldCloneRepo: false,
      shouldRefreshSnapshotRepo: true,
      setupScriptMode: "skip",
    });
  });

  it("plans checkout only when reusing a requested branch", () => {
    expect(
      buildPlan({
        createNewBranch: false,
        branchName: "feature/test",
      }).branchAction,
    ).toEqual({ type: "checkout", branchName: "feature/test" });

    expect(
      buildPlan({
        createNewBranch: false,
        branchName: undefined,
      }).branchAction,
    ).toEqual({ type: "none" });
  });

  it("keeps fast resume narrow while still refreshing codex files", () => {
    expect(
      buildPlan(
        {
          agent: "codex",
          fastResume: true,
          autoUpdateDaemon: true,
        },
        false,
      ),
    ).toMatchObject({
      shouldProbeSandboxAgent: false,
      shouldUpdateAgentFiles: true,
      agentToUpdate: "codex",
      shouldRestartDaemon: true,
      shouldUpdateDaemonBeforeRestart: false,
    });

    expect(
      buildPlan(
        {
          agent: "claudeCode",
          fastResume: true,
        },
        false,
      ),
    ).toMatchObject({
      shouldUpdateAgentFiles: false,
      agentToUpdate: null,
    });
  });

  it("plans daemon updates only for non-fast resumes with auto update enabled", () => {
    expect(
      buildPlan(
        {
          autoUpdateDaemon: true,
        },
        false,
      ),
    ).toMatchObject({
      shouldRestartDaemon: true,
      shouldUpdateDaemonBeforeRestart: true,
    });
  });
});

describe("buildSandboxBootRecipe", () => {
  it("makes fresh clone boot ordering explicit", () => {
    expect(
      buildSandboxBootRecipe({
        options: defaultOptions,
        isCreatingSandbox: true,
      }).steps.map((step) => step.type),
    ).toEqual([
      "profile",
      "git-credentials",
      "clone-repo",
      "git-identity",
      "branch",
      "git-clean",
      "install-daemon-and-probe",
      "setup-script",
      "probe-sandbox-agent",
    ]);
  });

  it("models Daytona volume setup only when a volume is configured", () => {
    expect(
      buildSandboxBootRecipe({
        options: {
          ...defaultOptions,
          sandboxProvider: "daytona",
          daytonaVolume: {
            volumeName: "vol",
            volumeMountPath: "/mnt/vol",
            volumeSubpath: "subpath",
            cacheMountPath: "/mnt/vol/cache",
            workspaceMountPath: "/mnt/vol/workspace",
            artifactsPath: "/mnt/vol/workspace/artifacts",
          },
        },
        isCreatingSandbox: true,
      }).steps,
    ).toContainEqual({ type: "daytona-volume-paths" });
  });

  it("uses snapshot refresh and skips setup for snapshot boots", () => {
    const recipe = buildSandboxBootRecipe({
      options: {
        ...defaultOptions,
        snapshotTemplateId: "repo-owner-repo-small-123",
        backgroundSetupScript: true,
      },
      isCreatingSandbox: true,
    });

    expect(recipe.steps).toContainEqual({ type: "refresh-snapshot-repo" });
    expect(
      recipe.steps.findIndex((step) => step.type === "git-credentials"),
    ).toBeLessThan(
      recipe.steps.findIndex((step) => step.type === "refresh-snapshot-repo"),
    );
    expect(recipe.steps).toContainEqual({
      type: "setup-script",
      mode: "skip",
    });
    expect(recipe.steps).not.toContainEqual({ type: "clone-repo" });
  });

  it("keeps fast resume to credentials plus codex file refresh and daemon restart", () => {
    expect(
      buildSandboxBootRecipe({
        options: {
          ...defaultOptions,
          agent: "codex",
          fastResume: true,
          autoUpdateDaemon: true,
        },
        isCreatingSandbox: false,
      }),
    ).toEqual({
      provider: "docker",
      mode: "resume",
      steps: [
        { type: "git-credentials" },
        { type: "update-agent-files", agent: "codex" },
        { type: "restart-daemon", updateBeforeRestart: false },
      ],
    });
  });
});
