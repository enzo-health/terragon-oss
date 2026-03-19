import { describe, expect, it, vi } from "vitest";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { bashQuote } from "@terragon/sandbox/utils";
import {
  reconcileSandboxBranchForThread,
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
