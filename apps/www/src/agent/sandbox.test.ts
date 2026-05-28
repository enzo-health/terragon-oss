import { describe, expect, it, vi } from "vitest";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { bashQuote } from "@terragon/sandbox/utils";
import {
  getDaytonaVolumeEnvironmentEntries,
  reconcileSandboxBranchForThread,
  resolveDaytonaVolumeConfig,
  resolveExpectedBranchForReconciliation,
  type SandboxBranchReconciliationResult,
} from "./sandbox";

function createSession(
  overrides: Partial<ISandboxSession> & {
    runCommand: ISandboxSession["runCommand"];
  },
): ISandboxSession {
  const { runCommand, ...restOverrides } = overrides;
  return {
    sandboxId: "sandbox-1",
    sandboxProvider: "docker",
    homeDir: "/home/sandbox",
    repoDir: "/repo",
    hibernate: vi.fn().mockResolvedValue(undefined),
    runBackgroundCommand: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    readTextFile: vi.fn().mockResolvedValue(""),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...restOverrides,
    runCommand,
  };
}

async function expectBranchResult(
  resultPromise: Promise<SandboxBranchReconciliationResult>,
  expectedBranchName: string,
  restarted: boolean,
) {
  const result = await resultPromise;
  expect(result.reconciled).toBe(true);
  expect(result.restarted).toBe(restarted);
  expect(result.currentBranchName).toBe(expectedBranchName);
}

describe("reconcileSandboxBranchForThread", () => {
  it("keeps the current sandbox when the branch already matches", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce("terragon/test-branch\n");
    const session = createSession({ runCommand });
    const restartSandbox = vi.fn();

    const result = await reconcileSandboxBranchForThread({
      session,
      expectedBranchName: "terragon/test-branch",
      restartSandbox,
    });

    expect(result).toEqual({
      session,
      reconciled: false,
      restarted: false,
      currentBranchName: "terragon/test-branch",
    });
    expect(runCommand).toHaveBeenCalledWith("git rev-parse --abbrev-ref HEAD", {
      cwd: "/repo",
    });
    expect(restartSandbox).not.toHaveBeenCalled();
  });

  it("checks out the expected branch before dispatch when the sandbox drifted", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce("terragon/old-branch\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("terragon/test-branch\n");
    const session = createSession({ runCommand });
    const restartSandbox = vi.fn();

    await expectBranchResult(
      reconcileSandboxBranchForThread({
        session,
        expectedBranchName: "terragon/test-branch",
        restartSandbox,
      }),
      "terragon/test-branch",
      false,
    );

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      `git checkout ${bashQuote("terragon/test-branch")}`,
      { cwd: "/repo" },
    );
    expect(restartSandbox).not.toHaveBeenCalled();
  });

  it("restarts the sandbox when branch checkout fails", async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return "terragon/old-branch\n";
      }
      throw new Error("checkout failed");
    });
    const session = createSession({ runCommand });
    const restartedRunCommand = vi
      .fn()
      .mockResolvedValueOnce("terragon/test-branch\n");
    const restartedSession = createSession({
      sandboxId: "sandbox-2",
      runCommand: restartedRunCommand,
    });
    const restartSandbox = vi.fn().mockResolvedValue(restartedSession);

    await expectBranchResult(
      reconcileSandboxBranchForThread({
        session,
        expectedBranchName: "terragon/test-branch",
        restartSandbox,
      }),
      "terragon/test-branch",
      true,
    );

    expect(restartSandbox).toHaveBeenCalledTimes(1);
  });

  it("recreates the expected branch from base before restarting", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce("terragon/old-branch\n")
      .mockRejectedValueOnce(new Error("checkout failed"))
      .mockRejectedValueOnce(new Error("fetch expected failed"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("terragon/test-branch\n");
    const session = createSession({ runCommand });
    const restartSandbox = vi.fn();

    await expectBranchResult(
      reconcileSandboxBranchForThread({
        session,
        expectedBranchName: "terragon/test-branch",
        baseBranchName: "main",
        restartSandbox,
      }),
      "terragon/test-branch",
      false,
    );

    expect(runCommand).toHaveBeenCalledWith(
      `git checkout -B ${bashQuote("terragon/test-branch")} ${bashQuote("origin/main")}`,
      { cwd: "/repo" },
    );
    expect(restartSandbox).not.toHaveBeenCalled();
  });

  it("classifies restart failures as daemon_spawn_failed", async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return "terragon/old-branch\n";
      }
      throw new Error("checkout failed");
    });
    const session = createSession({ runCommand });
    const restartSandbox = vi
      .fn()
      .mockRejectedValue(new Error("restart failed"));

    await expect(
      reconcileSandboxBranchForThread({
        session,
        expectedBranchName: "terragon/test-branch",
        restartSandbox,
      }),
    ).rejects.toMatchObject({
      name: "ThreadError",
      type: "sandbox-resume-failed",
      failureCategory: "daemon_spawn_failed",
    });
  });

  it("fails with a structured retryable error when drift cannot be reconciled", async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return "terragon/old-branch\n";
      }
      throw new Error("checkout failed");
    });
    const session = createSession({ runCommand });
    const restartedRunCommand = vi.fn(async (command: string) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return "terragon/wrong-branch\n";
      }
      throw new Error("checkout failed again");
    });
    const restartedSession = createSession({
      sandboxId: "sandbox-2",
      runCommand: restartedRunCommand,
    });
    const restartSandbox = vi.fn().mockResolvedValue(restartedSession);

    await expect(
      reconcileSandboxBranchForThread({
        session,
        expectedBranchName: "terragon/test-branch",
        restartSandbox,
      }),
    ).rejects.toMatchObject({
      name: "ThreadError",
      type: "sandbox-resume-failed",
      failureCategory: "daemon_spawn_failed",
    });
  });
});

describe("resolveExpectedBranchForReconciliation", () => {
  it("does not force base branch reconciliation for createNewBranch runs", () => {
    expect(
      resolveExpectedBranchForReconciliation({
        createNewBranch: true,
        requestedBranchName: "main",
        threadBranchName: null,
        repoBaseBranchName: "main",
      }),
    ).toBeNull();
  });

  it("prefers persisted thread branch for follow-up dispatches", () => {
    expect(
      resolveExpectedBranchForReconciliation({
        createNewBranch: false,
        requestedBranchName: "main",
        threadBranchName: "terragon/feature-123",
        repoBaseBranchName: "main",
      }),
    ).toBe("terragon/feature-123");
  });

  it("uses requested branch when createNewBranch=false and no persisted branch exists", () => {
    expect(
      resolveExpectedBranchForReconciliation({
        createNewBranch: false,
        requestedBranchName: "feature/existing-branch",
        threadBranchName: null,
        repoBaseBranchName: "main",
      }),
    ).toBe("feature/existing-branch");
  });
});

describe("resolveDaytonaVolumeConfig", () => {
  it("returns undefined when Daytona volume storage is not configured", () => {
    expect(
      resolveDaytonaVolumeConfig({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        repoFullName: "owner/repo",
        volumeName: "",
      }),
    ).toBeUndefined();
  });

  it("builds isolated cache and workspace subpaths", () => {
    expect(
      resolveDaytonaVolumeConfig({
        userId: "user/1",
        environmentId: "env:1",
        threadId: "thread 1",
        repoFullName: "owner/repo",
        volumeName: " terragon-workspaces ",
      }),
    ).toEqual({
      volumeName: "terragon-workspaces",
      cacheMountPath: "/mnt/terragon/cache",
      cacheSubpath: "users/user_1/cache",
      workspaceMountPath: "/mnt/terragon/workspace",
      workspaceSubpath:
        "users/user_1/environments/env_1/repos/owner_repo/threads/thread_1",
    });
  });

  it("uses no-repo workspace isolation while still using volume-backed caches", () => {
    expect(
      resolveDaytonaVolumeConfig({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        repoFullName: null,
        volumeName: "terragon-workspaces",
      }),
    ).toMatchObject({
      workspaceSubpath:
        "users/user-1/environments/env-1/repos/no-repo/threads/thread-1",
    });
  });
});

describe("getDaytonaVolumeEnvironmentEntries", () => {
  it("returns cache and artifact defaults for Daytona volume sandboxes", () => {
    const daytonaVolume = resolveDaytonaVolumeConfig({
      userId: "user-1",
      environmentId: "env-1",
      threadId: "thread-1",
      repoFullName: "owner/repo",
      volumeName: "terragon-workspaces",
    });

    expect(getDaytonaVolumeEnvironmentEntries(daytonaVolume)).toEqual(
      expect.arrayContaining([
        { key: "PNPM_STORE_DIR", value: "/mnt/terragon/cache/pnpm-store" },
        {
          key: "npm_config_store_dir",
          value: "/mnt/terragon/cache/pnpm-store",
        },
        { key: "GOMODCACHE", value: "/mnt/terragon/cache/go/pkg/mod" },
        {
          key: "TERRAGON_ARTIFACTS_DIR",
          value: "/mnt/terragon/workspace/artifacts",
        },
        { key: "XDG_CACHE_HOME", value: "/mnt/terragon/cache/xdg" },
        { key: "COREPACK_HOME", value: "/mnt/terragon/cache/corepack" },
        { key: "TURBO_CACHE_DIR", value: "/mnt/terragon/cache/turbo" },
        {
          key: "PLAYWRIGHT_BROWSERS_PATH",
          value: "/mnt/terragon/cache/ms-playwright",
        },
        {
          key: "PUPPETEER_CACHE_DIR",
          value: "/mnt/terragon/cache/puppeteer",
        },
        {
          key: "CYPRESS_CACHE_FOLDER",
          value: "/mnt/terragon/cache/cypress",
        },
        { key: "HF_HOME", value: "/mnt/terragon/cache/huggingface" },
        {
          key: "TRANSFORMERS_CACHE",
          value: "/mnt/terragon/cache/huggingface/transformers",
        },
        {
          key: "SENTENCE_TRANSFORMERS_HOME",
          value: "/mnt/terragon/cache/huggingface/sentence-transformers",
        },
        { key: "MPLCONFIGDIR", value: "/mnt/terragon/cache/matplotlib" },
        {
          key: "ESLINT_CACHE_LOCATION",
          value: "/mnt/terragon/cache/eslint/.eslintcache",
        },
      ]),
    );
  });
});
