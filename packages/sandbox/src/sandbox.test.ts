import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { DockerProvider } from "./providers/docker-provider";
import {
  DAEMON_FILE_PATH,
  DAEMON_LOG_FILE_PATH,
  getDaemonLogs,
  sendMessage,
} from "./daemon";
import type { SandboxProvider } from "@leo/types/sandbox";
import type { ISandboxSession, CreateSandboxOptions } from "./types";
import { getDaemonFile } from "./constants";
import { setupSandboxEveryTime } from "./setup";
import { createHash } from "crypto";
import { nanoid } from "nanoid/non-secure";
import { gitDiff } from "./commands/git-diff";
import { gitDiffStats } from "./commands/git-diff-stats";
import { gitPushWithRebase } from "./commands/git-push-with-rebase";
import { gitPullUpstream } from "./commands/git-pull-upstream";
import { getGitDefaultBranch } from "./commands/git-default-branch";
import { gitCommitAndPushBranch } from "./commands/git-commit-and-push";
import { getOrCreateSandbox } from "./sandbox";
import { bashQuote } from "./utils";
import { defaultUnixSocketPath } from "@leo/daemon/shared";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Mock getDaemonFile
vi.mock("./constants", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    getDaemonFile: vi.fn(() => actual.getDaemonFile()),
  };
});

let providerName: SandboxProvider = "docker";
if (process.env.SANDBOX_PROVIDER) {
  if (process.env.SANDBOX_PROVIDER === "e2b") {
    providerName = "e2b";
  } else if (process.env.SANDBOX_PROVIDER === "daytona") {
    providerName = "daytona";
  } else {
    throw new Error(
      `Invalid sandbox provider: ${process.env.SANDBOX_PROVIDER}`,
    );
  }
}
function getCreateSandboxOptions(
  providerName: SandboxProvider,
  overrides: Partial<CreateSandboxOptions> = {},
): CreateSandboxOptions {
  return {
    threadName: "test-title",
    userName: "test-user",
    userEmail: "test@example.com",
    githubAccessToken: "test-token",
    githubRepoFullName: "SawyerHood/test-project",
    repoBaseBranchName: "main",
    userId: "user-123",
    sandboxProvider: providerName,
    createNewBranch: true,
    autoUpdateDaemon: false,
    sandboxSize: "small",
    publicUrl: "http://localhost:3000",
    featureFlags: {},
    agent: null,
    agentCredentials: null,
    environmentVariables: [{ key: "TEST_VAR1", value: "value1" }],
    generateBranchName: async () => null,
    onStatusUpdate: async () => {},
    ...overrides,
  };
}

describe(`sandbox ${providerName}`, () => {
  vi.setConfig({ testTimeout: TIMEOUT_MS });
  let sandbox: ISandboxSession;

  beforeAll(async () => {
    sandbox = await getOrCreateSandbox(
      null,
      getCreateSandboxOptions(providerName),
    );
  }, TIMEOUT_MS /* Extra time for the sandbox to start */);

  afterAll(async () => {
    try {
      await sandbox.shutdown();
    } catch {}
    // Cleanup test containers. If using the docker provider, you can comment this out.
    // to make keep the containers around for debugging.
    await DockerProvider.cleanupTestContainers();
  });

  it("should create a sandbox", async () => {
    expect(sandbox.sandboxId).toBeDefined();
    expect(sandbox.sandboxProvider).toBe(providerName);
    expect(sandbox.sandboxId).toBeDefined();
    const result = await sandbox.runCommand("echo 'HELLO'");
    expect(result).toContain("HELLO");

    // Should have node
    const nodeHelp = await sandbox.runCommand("node -h");
    expect(nodeHelp).toContain("Usage: node");
    // Should have git
    const gitHelp = await sandbox.runCommand("git --version");
    expect(gitHelp).toContain("git version");

    // Skip these for docker since we use a test image that doesn't have these installed.
    if (sandbox.sandboxProvider === "e2b") {
      // Should have pnpm
      const pnpmHelp = await sandbox.runCommand("pnpm -h");
      expect(pnpmHelp).toContain("Usage: pnpm");

      // Should have claude code
      const claudeCodeHelp = await sandbox.runCommand("claude -h");
      expect(claudeCodeHelp).toContain("Usage: claude");
    }
  });

  it("should handle file operations", async () => {
    // Test writing and reading a text file
    const testContent = "Hello from sandbox!";
    const testFilePath = "/tmp/test-file.txt";
    await sandbox.writeTextFile(testFilePath, testContent);
    const readContent = await sandbox.readTextFile(testFilePath);
    expect(readContent).toBe(testContent);
  });

  it("should handle binary file operations", async () => {
    // Test writing and reading a binary file
    const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" in bytes
    const binaryFilePath = "/tmp/test-binary.bin";
    await sandbox.writeFile(binaryFilePath, binaryData);

    // Read back as text to verify
    const readResult = await sandbox.runCommand(`cat ${binaryFilePath}`);
    expect(readResult.trim()).toBe("Hello");
  });

  it("should have the leo-daemon file and log", async () => {
    // Should have the leo-daemon file
    const daemonBin = await sandbox.readTextFile(DAEMON_FILE_PATH);
    expect(daemonBin).toContain("#!/usr/bin/env node");

    // Should have the leo-daemon log (and have started successfully)
    const daemonLogs = await sandbox.readTextFile(DAEMON_LOG_FILE_PATH);
    expect(daemonLogs).toContain("Daemon started successfully");

    // Should have the leo-daemon unix socket file
    const unixSocketFileExists = await sandbox.runCommand(
      `ls -l ${defaultUnixSocketPath} && echo 'OK'`,
    );
    expect(unixSocketFileExists.trim()).toContain("OK");
  });

  it("should have cloned the repo and made a new branch", async () => {
    const result1 = await sandbox.runCommand("git remote -v");
    expect(result1).toContain(
      "origin\thttps://github.com/SawyerHood/test-project.git (fetch)",
    );

    const result2 = await sandbox.runCommand("git branch -a");
    expect(result2).toContain("* leo/");
  });

  it("should respond to a daemon message", async () => {
    let daemonLogs: any[] = [];
    daemonLogs = await getDaemonLogs({ session: sandbox });
    if (
      !daemonLogs.find((log) => {
        const message = typeof log === "string" ? log : log.message;
        return message?.includes("Daemon started successfully");
      })
    ) {
      throw new Error("Daemon did not start successfully");
    }
    daemonLogs = await getDaemonLogs({ session: sandbox });
    if (
      daemonLogs.find((log) => {
        return (
          typeof log !== "string" &&
          log.message?.includes("Received unix socket message") &&
          log.data?.message?.includes("TEST_PROMPT_STRING")
        );
      })
    ) {
      throw new Error("Daemon should not have received pipe message yet");
    }
    await sendMessage({
      session: sandbox,
      message: {
        type: "claude",
        agent: "claudeCode",
        agentVersion: 1,
        token: "test-token",
        prompt: "TEST_PROMPT_STRING",
        model: "sonnet",
        sessionId: null,
        threadId: "test-thread-id",
        threadChatId: "test-thread-chat-id",
      },
    });
    daemonLogs = await getDaemonLogs({ session: sandbox });
    const receivedAckMessage = daemonLogs.find((log) => {
      return (
        typeof log !== "string" &&
        log.message?.includes("Received unix socket message") &&
        log.data?.message?.includes("TEST_PROMPT_STRING")
      );
    });
    if (!receivedAckMessage) {
      throw new Error("Daemon should have received ack message");
    }
    const parsedData = JSON.parse(receivedAckMessage.data.message);
    expect(parsedData.type).toBe("claude");
    expect(parsedData.prompt).toBe("TEST_PROMPT_STRING");
    expect(parsedData.model).toBe("sonnet");
    expect(parsedData.sessionId).toBeNull();
    expect(parsedData.threadId).toBe("test-thread-id");
    expect(parsedData.token).toBeDefined();

    await sleepUntil(async () => {
      const daemonLogs = await getDaemonLogs({ session: sandbox });
      return daemonLogs.find((log) => {
        return (
          typeof log !== "string" &&
          log.message?.includes("Spawning agent process")
        );
      });
    });
    daemonLogs = await getDaemonLogs({ session: sandbox });
    const startedAgentProcess = daemonLogs.find((log) => {
      const message = typeof log === "string" ? log : log.message;
      return message?.includes("Spawning agent process");
    });
    if (!startedAgentProcess) {
      throw new Error("Daemon should have started agent process");
    }
    const startedClaudeCommand = startedAgentProcess.data.command;
    expect(startedClaudeCommand).toContain("cat");
    expect(startedClaudeCommand).toContain("/tmp/claude-prompt-");
    expect(startedClaudeCommand).toContain("claude -p --model sonnet");
  });

  it("should have GitHub CLI (gh) installed", async () => {
    // Check if gh is installed
    const ghVersion = await sandbox.runCommand("gh --version");
    expect(ghVersion).toContain("gh version");
    // Check that gh is available in PATH
    const ghPath = await sandbox.runCommand("which gh");
    expect(ghPath).toContain("/gh");
  });

  it("should update daemon when autoUpdateDaemon is enabled", async () => {
    // Get the current daemon content and hash
    const originalDaemonContent = await sandbox.readTextFile(DAEMON_FILE_PATH);
    const originalHash = createHash("sha256")
      .update(originalDaemonContent)
      .digest("hex");

    // Verify the daemon is running
    const psOutput = await sandbox.runCommand(
      "ps aux | grep leo-daemon.mjs | grep -v grep",
    );
    expect(psOutput).toContain("node");
    expect(psOutput).toContain("leo-daemon.mjs");

    // Mock getDaemonFile to return different content
    const newDaemonContent =
      originalDaemonContent + "\n// Updated daemon content for testing";
    vi.mocked(getDaemonFile).mockReturnValue(newDaemonContent);

    // Run setupSandboxEveryTime with autoUpdateDaemon enabled
    await setupSandboxEveryTime({
      session: sandbox,
      options: getCreateSandboxOptions(providerName, {
        autoUpdateDaemon: true,
      }),
      isCreatingSandbox: false,
    });

    // Wait a bit for the daemon to restart
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the daemon file was updated
    const updatedDaemonContent = await sandbox.readTextFile(DAEMON_FILE_PATH);
    const updatedHash = createHash("sha256")
      .update(updatedDaemonContent)
      .digest("hex");
    expect(updatedHash).not.toBe(originalHash);
    expect(updatedDaemonContent).toContain(
      "// Updated daemon content for testing",
    );

    // Verify the daemon is running again
    const psOutputAfter = await sandbox.runCommand(
      "ps aux | grep leo-daemon.mjs | grep -v grep",
    );
    expect(psOutputAfter).toContain("node");
    expect(psOutputAfter).toContain("leo-daemon.mjs");

    // Check that daemon started successfully after update
    const daemonLogs = await getDaemonLogs({ session: sandbox });
    const startupLog = daemonLogs.find((log: any) => {
      const message = typeof log === "string" ? log : log.message;
      return message?.includes("Daemon started successfully");
    });
    expect(startupLog).toBeDefined();
  });

  it("should not update daemon when autoUpdateDaemon is disabled", async () => {
    // Get the current daemon content
    const originalDaemonContent = await sandbox.readTextFile(DAEMON_FILE_PATH);
    const originalHash = createHash("sha256")
      .update(originalDaemonContent)
      .digest("hex");

    // Mock getDaemonFile to return different content
    const newDaemonContent =
      originalDaemonContent + "\n// This should not be written";
    vi.mocked(getDaemonFile).mockReturnValue(newDaemonContent);

    // Run setupSandboxEveryTime with autoUpdateDaemon disabled
    await setupSandboxEveryTime({
      session: sandbox,
      options: getCreateSandboxOptions(providerName, {
        autoUpdateDaemon: false,
      }),
      isCreatingSandbox: false,
    });

    // Verify the daemon file was NOT updated
    const currentDaemonContent = await sandbox.readTextFile(DAEMON_FILE_PATH);
    const currentHash = createHash("sha256")
      .update(currentDaemonContent)
      .digest("hex");
    expect(currentHash).toBe(originalHash);
    expect(currentDaemonContent).not.toContain("// This should not be written");
  });

  describe("sandbox branch integration", () => {
    it("should checkout the specified base branch before creating new branch", async () => {
      // Check git log to verify we branched from main
      await sandbox.runCommand("git log --oneline -n 5");

      // The first few commits should be from main branch
      // We can't check exact commits, but we can verify branch structure
      const currentBranch = await sandbox.runCommand(
        "git branch --show-current",
      );
      expect(currentBranch.trim()).toMatch(/^leo\//);

      // Check that we're on a new branch created from main
      const branchPoint = await sandbox.runCommand("git merge-base HEAD main");
      const mainHead = await sandbox.runCommand("git rev-parse main");

      // The branch point should be the same as main HEAD (we branched from main)
      expect(branchPoint.trim()).toBe(mainHead.trim());
    });

    it("should respect different base branches", async () => {
      // Create a new thread with a different base branch if it exists
      const branchListResult = await sandbox.runCommand("git branch -r");
      const branches = branchListResult
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.includes("HEAD"));

      // If there's a branch other than main, test with it
      const alternateBranch = branches
        .find((b) => !b.includes("/main"))
        ?.replace("origin/", "");

      if (alternateBranch) {
        const newSandbox = await getOrCreateSandbox(
          null,
          getCreateSandboxOptions(providerName, {
            repoBaseBranchName: alternateBranch,
          }),
        );
        try {
          // Verify we branched from the alternate branch
          const branchPoint = await newSandbox.runCommand(
            `git merge-base HEAD ${alternateBranch}`,
          );
          const altBranchHead = await newSandbox.runCommand(
            `git rev-parse ${alternateBranch}`,
          );

          expect(branchPoint.trim()).toBe(altBranchHead.trim());
        } finally {
          await newSandbox.shutdown();
        }
      }
    });

    it("should not create new branch when createNewBranch is false", async () => {
      const noNewBranchSandbox = await getOrCreateSandbox(
        null,
        getCreateSandboxOptions(providerName, {
          createNewBranch: false, // Don't create new branch
        }),
      );
      try {
        // Should be on main branch
        const currentBranch = await noNewBranchSandbox.runCommand(
          "git branch --show-current",
        );
        expect(currentBranch.trim()).toBe("main");
      } finally {
        await noNewBranchSandbox.shutdown();
      }
    });
  });

  describe("commands", () => {
    describe("git-default-branch", () => {
      it("git-default-branch should return 'main' for a repository with main as default branch", async () => {
        // The test repository (SawyerHood/test-project) uses 'main' as the default branch
        const branch = await getGitDefaultBranch(sandbox);
        expect(branch).toBe("main");
      });

      it("git-default-branch should detect custom branch names from origin/HEAD", async () => {
        // Create a test repo with a custom default branch
        const testDir = "/tmp/git-default-branch-test-" + Date.now();
        await createTestRepo(sandbox, testDir);

        await sandbox.runCommand(
          [
            "git branch -m custom-branch",
            'echo "test" > test.txt && git add test.txt && git commit -m "Initial commit"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Set up a bare remote repo
        const remoteDir = "/tmp/remote-repo-" + Date.now();
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin custom-branch",
            "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/custom-branch",
          ].join(" && "),
          { cwd: testDir },
        );
        // Test from the test directory
        const branch = await getGitDefaultBranch(sandbox, testDir);
        expect(branch).toBe("custom-branch");
      });

      it("git-default-branch should use git config init.defaultBranch when origin/HEAD is not set", async () => {
        // Create a test repo without remotes
        const testDir = "/tmp/git-default-branch-test-" + Date.now();
        await sandbox.runCommand(`mkdir -p ${testDir}`);
        await sandbox.runCommand(
          ["git init", "git config init.defaultBranch develop"].join(" && "),
          { cwd: testDir },
        );

        // Test from the test directory
        const branch = await getGitDefaultBranch(sandbox, testDir);
        expect(branch).toBe("develop");
      });

      it("git-default-branch should fall back to 'main' when no default branch info is available", async () => {
        // Create a minimal git repo without any remotes or config
        const testDir = "/tmp/git-default-branch-test-" + Date.now();
        await sandbox.runCommand(`mkdir -p ${testDir}`);
        await sandbox.runCommand(
          ["git init", "git config --unset init.defaultBranch || true"].join(
            " && ",
          ),
          { cwd: testDir },
        );

        // Test from the test directory
        const branch = await getGitDefaultBranch(sandbox, testDir);
        expect(branch).toBe("main");
      });
    });

    describe("git-diff", () => {
      it("should generate git diff and write to output file", async () => {
        // Create a test directory
        const testDir = "/tmp/write-git-diff-test-" + nanoid();
        await createTestRepo(sandbox, testDir);
        await sandbox.runCommand(
          [
            'echo "new content" > newfile.txt',
            'echo "untracked content" > untracked.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        const outputFile = "/tmp/test-output-" + nanoid() + ".patch";
        const result = await gitDiff(sandbox, {
          outputFile,
          repoRoot: testDir,
        });

        expect(result).toBe(`Git diff written to: ${outputFile}`);

        // Verify the diff content
        const diffContent = await sandbox.readTextFile(outputFile);
        expect(diffContent).toContain("diff --git");
        expect(diffContent).toContain("newfile.txt");
        expect(diffContent).toContain("+new content");
        expect(diffContent).toContain("untracked.txt");
        expect(diffContent).toContain("+untracked content");
      });

      it("should handle empty diff when no changes exist", async () => {
        // Create a test directory
        const testDir = "/tmp/write-git-diff-test-" + nanoid();
        await createTestRepo(sandbox, testDir);

        // Don't create any new files - working directory is clean
        const outputFile = "empty-diff-" + nanoid() + ".patch";
        const result = await gitDiff(sandbox, {
          outputFile,
          repoRoot: testDir,
        });

        expect(result).toBe(`Git diff written to: ${outputFile}`);

        // Verify the diff is empty
        const diffContent = await sandbox.readTextFile(
          `${testDir}/${outputFile}`,
        );
        expect(diffContent.trim()).toBe("");
      });

      it("should use upstream branch when available", async () => {
        // Create a test directory
        const testDir = "/tmp/write-git-diff-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Get the current branch name
        const currentBranch = (
          await sandbox.runCommand("git branch --show-current", {
            cwd: testDir,
          })
        ).trim();

        // Create a remote repository
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            `git push -u origin ${currentBranch}`,
            "git checkout -b develop",
            'echo "develop content" > develop-file.txt',
            "git add develop-file.txt",
            'git commit -m "Develop branch commit"',
            "git push -u origin develop",
            "git checkout -b feature/test",
            'echo "feature content" > feature-file.txt',
            "git add feature-file.txt",
            'git commit -m "Feature commit"',
            "git push -u origin feature/test",
            // Make additional uncommitted changes
            'echo "uncommitted content" > uncommitted.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        const outputFile = "/tmp/upstream-test-" + nanoid() + ".patch";
        const result = await gitDiff(sandbox, {
          outputFile,
          repoRoot: testDir,
        });

        expect(result).toBe(`Git diff written to: ${outputFile}`);

        const diffContent = await sandbox.readTextFile(outputFile);

        // Should contain ALL changes that would be introduced to main
        expect(diffContent).toContain("feature-file.txt");
        expect(diffContent).toContain("develop-file.txt");
        expect(diffContent).toContain("uncommitted.txt");

        // Should NOT contain initial.txt as it exists in main
        expect(diffContent).not.toContain("initial.txt");
      });

      it("should use provided baseBranch instead of default branch", async () => {
        // Create a test directory
        const testDir = "/tmp/git-diff-base-branch-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Create a remote repository with multiple branches
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            `git push -u origin main`,
            // Create develop branch with some changes
            "git checkout -b develop",
            'echo "develop base content" > develop-base.txt',
            "git add develop-base.txt",
            'git commit -m "Develop base commit"',
            "git push -u origin develop",
            // Create feature branch from develop
            "git checkout -b feature/test",
            'echo "feature content" > feature-file.txt',
            "git add feature-file.txt",
            'git commit -m "Feature commit"',
            "git push -u origin feature/test",
            // Make additional uncommitted changes
            'echo "uncommitted content" > uncommitted.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        // Test with baseBranch = "develop"
        const outputFile = "/tmp/base-branch-test-" + nanoid() + ".patch";
        const result = await gitDiff(sandbox, {
          outputFile,
          repoRoot: testDir,
          baseBranch: "develop",
        });

        expect(result).toBe(`Git diff written to: ${outputFile}`);

        const diffContent = await sandbox.readTextFile(outputFile);

        // Should only contain changes since develop branch
        expect(diffContent).toContain("feature-file.txt");
        expect(diffContent).toContain("uncommitted.txt");

        // Should NOT contain develop-base.txt as it exists in develop branch
        expect(diffContent).not.toContain("develop-base.txt");
      });

      it("should handle baseBranch with remote prefix", async () => {
        // Create a test directory
        const testDir = "/tmp/git-diff-remote-prefix-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Create a remote repository
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            `git push -u origin main`,
            // Create develop branch
            "git checkout -b develop",
            'echo "develop content" > develop.txt',
            "git add develop.txt",
            'git commit -m "Develop commit"',
            "git push -u origin develop",
            // Create feature branch
            "git checkout -b feature/test",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Feature commit"',
            // Make uncommitted changes
            'echo "uncommitted" > uncommitted.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        // Test with baseBranch = "origin/develop" (with remote prefix)
        const outputFile = "/tmp/remote-prefix-test-" + nanoid() + ".patch";
        const result = await gitDiff(sandbox, {
          outputFile,
          repoRoot: testDir,
          baseBranch: "origin/develop",
        });

        expect(result).toBe(`Git diff written to: ${outputFile}`);

        const diffContent = await sandbox.readTextFile(outputFile);

        // Should only contain changes since origin/develop
        expect(diffContent).toContain("feature.txt");
        expect(diffContent).toContain("uncommitted.txt");

        // Should NOT contain develop.txt
        expect(diffContent).not.toContain("develop.txt");
      });

      it("should fetch latest changes for baseBranch", async () => {
        // Create a test directory
        const testDir = "/tmp/git-diff-fetch-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();
        const otherUserDir = "/tmp/other-user-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            `git push -u origin main`,
            // Create develop branch
            "git checkout -b develop",
            'echo "initial develop" > develop.txt',
            "git add develop.txt",
            'git commit -m "Initial develop"',
            "git push -u origin develop",
            // Create feature branch
            "git checkout -b feature/test",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Feature commit"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Simulate another user updating develop branch
        await sandbox.runCommand(`mkdir -p ${otherUserDir}`);
        await sandbox.runCommand(
          [
            `git clone ${remoteDir} .`,
            'git config user.email "other@example.com"',
            'git config user.name "Other User"',
            "git checkout develop",
            'echo "updated develop content" > develop-update.txt',
            "git add develop-update.txt",
            'git commit -m "Update develop"',
            "git push",
          ].join(" && "),
          { cwd: otherUserDir },
        );

        // Generate diff with baseBranch = "develop"
        // This should fetch the latest develop changes
        const outputFile = "/tmp/fetch-test-" + nanoid() + ".patch";
        const result = await gitDiff(sandbox, {
          outputFile,
          repoRoot: testDir,
          baseBranch: "develop",
        });

        expect(result).toBe(`Git diff written to: ${outputFile}`);

        const diffContent = await sandbox.readTextFile(outputFile);

        // Should contain feature changes
        expect(diffContent).toContain("feature.txt");

        // Should NOT contain develop.txt or develop-update.txt since we're comparing
        // against the updated remote develop branch which already has these files
        expect(diffContent).not.toContain("develop.txt");
        expect(diffContent).not.toContain("develop-update.txt");
      });
    });

    describe("git-diff-stats", () => {
      it("should return correct stats for file changes", async () => {
        // Create a test directory
        const testDir = `/tmp/git-diff-stats-test-${nanoid()}`;
        await createTestRepo(sandbox, testDir);

        // Make some changes
        await sandbox.runCommand(
          [
            'echo "new content" > newfile.txt',
            'echo "modified content" >> initial.txt',
            'echo "another file" > another.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        const stats = await gitDiffStats(sandbox, {
          repoRoot: testDir,
        });

        expect(stats.files).toBe(3); // initial.txt modified, newfile.txt and another.txt added
        expect(stats.additions).toBeGreaterThan(0);
        expect(stats.deletions).toBe(0);
      });

      it("should return zero stats when no changes", async () => {
        // Create a test directory
        const testDir = `/tmp/git-diff-stats-test-${nanoid()}`;
        await createTestRepo(sandbox, testDir);

        // No changes made
        const stats = await gitDiffStats(sandbox, {
          repoRoot: testDir,
        });

        expect(stats.files).toBe(0);
        expect(stats.additions).toBe(0);
        expect(stats.deletions).toBe(0);
      });

      it("should track deletions correctly", async () => {
        // Create a test directory
        const testDir = `/tmp/git-diff-stats-test-${nanoid()}`;
        await createTestRepo(sandbox, testDir);

        // Create a file to delete
        await sandbox.runCommand(
          [
            'echo "file to delete" > delete-me.txt',
            "git add delete-me.txt",
            'git commit -m "Add file to delete"',
            "rm delete-me.txt",
            'echo "new file" > new.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        const stats = await gitDiffStats(sandbox, {
          repoRoot: testDir,
        });

        expect(stats.files).toBe(2); // delete-me.txt deleted, new.txt added
        expect(stats.additions).toBeGreaterThan(0);
        expect(stats.deletions).toBeGreaterThan(0);
      });

      it("should use upstream branch when available", async () => {
        // Create a test directory
        const testDir = `/tmp/git-diff-stats-test-${nanoid()}`;
        const remoteDir = `/tmp/remote-repo-${nanoid()}`;

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            `git push -u origin main`,
            "git checkout -b develop",
            'echo "develop content" > develop-file.txt',
            "git add develop-file.txt",
            'git commit -m "Develop branch commit"',
            "git push -u origin develop",
            "git checkout -b feature/test",
            'echo "feature content" > feature-file.txt',
            "git add feature-file.txt",
            'git commit -m "Feature commit"',
            "git push -u origin feature/test",
            // Make additional uncommitted changes
            'echo "uncommitted content" > uncommitted.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        const stats = await gitDiffStats(sandbox, {
          repoRoot: testDir,
        });

        // Should count ALL changes from main
        expect(stats.files).toBe(3); // develop-file.txt, feature-file.txt, uncommitted.txt
        expect(stats.additions).toBeGreaterThan(0);
      });

      it("should use provided baseBranch", async () => {
        // Create a test directory
        const testDir = `/tmp/git-diff-stats-base-test-${nanoid()}`;
        const remoteDir = `/tmp/remote-repo-${nanoid()}`;

        await createTestRepo(sandbox, testDir);

        // Create a remote repository with multiple branches
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            `git push -u origin main`,
            // Create develop branch with some changes
            "git checkout -b develop",
            'echo "develop base content" > develop-base.txt',
            "git add develop-base.txt",
            'git commit -m "Develop base commit"',
            "git push -u origin develop",
            // Create feature branch from develop
            "git checkout -b feature/test",
            'echo "feature content" > feature-file.txt',
            "git add feature-file.txt",
            'git commit -m "Feature commit"',
            "git push -u origin feature/test",
            // Make additional uncommitted changes
            'echo "uncommitted content" > uncommitted.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        // Test with baseBranch = "develop"
        const stats = await gitDiffStats(sandbox, {
          repoRoot: testDir,
          baseBranch: "develop",
        });

        // Should only count changes since develop branch
        expect(stats.files).toBe(2); // feature-file.txt and uncommitted.txt
        expect(stats.additions).toBeGreaterThan(0);
      });

      it("should handle complex changes with modifications", async () => {
        // Create a test directory
        const testDir = `/tmp/git-diff-stats-complex-${nanoid()}`;
        await createTestRepo(sandbox, testDir);

        // Make complex changes
        await sandbox.runCommand(
          [
            // Modify existing file
            'echo "additional line" >> initial.txt',
            // Add new files
            'echo "new file 1" > file1.txt',
            'echo "new file 2" > file2.txt',
            // Create a file with multiple lines
            'printf "line1\\nline2\\nline3\\nline4\\nline5\\n" > multiline.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        const stats = await gitDiffStats(sandbox, {
          repoRoot: testDir,
        });

        expect(stats.files).toBe(4); // initial.txt modified, 3 new files
        expect(stats.additions).toBeGreaterThanOrEqual(8); // At least 8 lines added
        expect(stats.deletions).toBe(0);
      });
    });

    describe("git-push-with-rebase", () => {
      it("should successfully push when no conflicts", async () => {
        const testDir = "/tmp/robust-git-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();
        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
          ].join(" && "),
          { cwd: testDir },
        );

        const result = await gitPushWithRebase(sandbox, {
          repoRoot: testDir,
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain(
          "Successfully pushed branch 'feature-branch'",
        );
        expect(result.error).toBeUndefined();
      });

      it("should prevent pushing to main branch", async () => {
        const testDir = "/tmp/robust-git-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
          ].join(" && "),
          { cwd: testDir },
        );

        const result = await gitPushWithRebase(sandbox, {
          branch: "main",
          repoRoot: testDir,
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(
          /Cannot push directly to default branch/,
        );
        expect(result.error).toBe("REJECTED");
      });

      it("should successfully rebase and push when remote has new commits", async () => {
        const testDir = "/tmp/robust-git-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();
        const otherUserDir = "/tmp/other-user-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
            "git push -u origin feature-branch",
          ].join(" && "),
          { cwd: testDir },
        );

        // Simulate another user pushing to the same branch
        await sandbox.runCommand(`mkdir -p ${otherUserDir}`);
        await sandbox.runCommand(
          [
            `git clone ${remoteDir} .`,
            'git config user.email "other@example.com"',
            'git config user.name "Other User"',
            "git checkout feature-branch",
            'echo "other user content" > other.txt',
            "git add other.txt",
            'git commit -m "Other user commit"',
            "git push",
          ].join(" && "),
          { cwd: otherUserDir },
        );

        // Make a local change
        await sandbox.runCommand(
          [
            'echo "local content" > local.txt',
            "git add local.txt",
            'git commit -m "Local commit"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Try to push - should trigger rebase
        const result = await gitPushWithRebase(sandbox, {
          repoRoot: testDir,
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain(
          "Successfully pushed branch 'feature-branch' after rebasing",
        );
        expect(result.didUpdate).toBe(true);
      });

      it("should detect and report merge conflicts", async () => {
        const testDir = "/tmp/robust-git-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();
        const otherUserDir = "/tmp/other-user-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            // Create a feature branch with a file
            "git checkout -b feature-branch",
            'echo "original content" > conflict.txt',
            "git add conflict.txt",
            'git commit -m "Add conflict file"',
            "git push -u origin feature-branch",
          ].join(" && "),
          { cwd: testDir },
        );

        // Simulate another user pushing conflicting changes
        await sandbox.runCommand(`mkdir -p ${otherUserDir}`);
        await sandbox.runCommand(
          [
            `git clone ${remoteDir} .`,
            'git config user.email "other@example.com"',
            'git config user.name "Other User"',
            "git checkout feature-branch",
            'echo "other user content" > conflict.txt',
            "git add conflict.txt",
            'git commit -m "Other user changes"',
            "git push",
          ].join(" && "),
          { cwd: otherUserDir },
        );
        // Make conflicting local changes
        await sandbox.runCommand(
          [
            'echo "my local content" > conflict.txt',
            "git add conflict.txt",
            'git commit -m "Local changes"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Try to push - should detect conflicts
        const result = await gitPushWithRebase(sandbox, {
          repoRoot: testDir,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain(
          "Cannot push: merge conflicts detected",
        );
        expect(result.error).toBe("CONFLICT");
      });

      it("should reject dangerous branch names", async () => {
        const result = await gitPushWithRebase(sandbox, {
          branch: "branch; rm -rf /",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid branch name");
        expect(result.error).toBe("UNKNOWN");
      });

      it("should push without -u flag when setUpstream is false", async () => {
        const testDir = "/tmp/robust-git-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "test content" > test.txt',
            "git add test.txt",
            'git commit -m "Test commit"',
          ].join(" && "),
          { cwd: testDir },
        );

        // First push with upstream
        await gitPushWithRebase(sandbox, { repoRoot: testDir });

        // Make another change
        await sandbox.runCommand(
          [
            'echo "test content 2" > test2.txt',
            "git add test2.txt",
            'git commit -m "Second commit"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Push without setting upstream
        const result = await gitPushWithRebase(sandbox, {
          setUpstream: false,
          repoRoot: testDir,
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain(
          "Successfully pushed branch 'feature-branch'",
        );
      });
    });

    describe("git-commit-and-push", () => {
      it("should fail gracefully when commit fails due to git hooks", async () => {
        const testDir = "/tmp/git-commit-hook-fail-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Create a pre-commit hook that fails
        const hookDir = `${testDir}/.git/hooks`;
        await sandbox.runCommand(`mkdir -p ${hookDir}`);
        await sandbox.writeTextFile(
          `${hookDir}/pre-commit`,
          `#!/bin/bash\necho "Pre-commit hook failing for test"\nexit 1`,
        );
        await sandbox.runCommand(`chmod +x ${hookDir}/pre-commit`);

        // Make changes that would normally commit successfully
        await sandbox.runCommand(
          'echo "uncommitted content" > uncommitted.txt',
          { cwd: testDir },
        );

        // Attempt to commit and push - should fail due to pre-commit hook
        await expect(
          gitCommitAndPushBranch({
            session: sandbox,
            args: {
              githubAppName: "test-app",
              baseBranch: "main",
              generateCommitMessage: async () => "Test commit message",
              repoRoot: testDir,
            },
            enableIntegrityChecks: false,
          }),
        ).rejects.toThrow();

        // Verify no commit was made
        const logOutput = await sandbox.runCommand("git log --oneline -n 2", {
          cwd: testDir,
        });
        expect(logOutput).not.toContain("Test commit message");

        // Verify uncommitted changes still exist
        const statusOutput = await sandbox.runCommand(
          "git status --porcelain",
          {
            cwd: testDir,
          },
        );
        expect(statusOutput).toContain("uncommitted.txt");
      });

      it("should not push when there are no changes to commit", async () => {
        const testDir = "/tmp/git-commit-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
          ].join(" && "),
          { cwd: testDir },
        );

        // Get the current commit before attempting to push
        const commitsBefore = await sandbox.runCommand("git log --oneline", {
          cwd: testDir,
        });

        // Run gitCommitAndPushBranch when there are no changes
        const result = await gitCommitAndPushBranch({
          session: sandbox,
          args: {
            githubAppName: "test-app",
            baseBranch: "main",
            generateCommitMessage: async () => "Test commit",
            repoRoot: testDir,
          },
          enableIntegrityChecks: false,
        });

        // Should return branch name without error
        expect(result).toEqual({ branchName: "feature-branch" });

        // Verify no new commits were made
        const commitsAfter = await sandbox.runCommand("git log --oneline", {
          cwd: testDir,
        });
        expect(commitsAfter).toBe(commitsBefore);

        // Verify the remote still has only the initial commit
        const remoteLogs = await sandbox.runCommand("git branch -r", {
          cwd: testDir,
        });
        expect(remoteLogs).not.toContain("feature-branch");
      });

      it("should commit and push when there are changes", async () => {
        const testDir = "/tmp/git-commit-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "new content" > newfile.txt',
          ].join(" && "),
          { cwd: testDir },
        );

        // Run gitCommitAndPushBranch when there are changes
        const result = await gitCommitAndPushBranch({
          session: sandbox,
          args: {
            githubAppName: "test-app",
            baseBranch: "main",
            generateCommitMessage: async (diff: string) => {
              expect(diff).toContain("newfile.txt");
              return "Add newfile.txt";
            },
            repoRoot: testDir,
          },
          enableIntegrityChecks: false,
        });

        // Should return branch name without error
        expect(result).toEqual({ branchName: "feature-branch" });

        // Verify the commit was made
        const localLog = await sandbox.runCommand("git log --oneline -n 1", {
          cwd: testDir,
        });
        expect(localLog).toContain("Add newfile.txt");

        // Verify the commit was pushed to remote
        await sandbox.runCommand("git fetch", { cwd: testDir });
        const remoteBranches = await sandbox.runCommand("git branch -r", {
          cwd: testDir,
        });
        expect(remoteBranches).toContain("origin/feature-branch");

        // Verify the file is in the remote
        const remoteLog = await sandbox.runCommand(
          "git log --oneline origin/feature-branch -n 1",
          { cwd: testDir },
        );
        expect(remoteLog).toContain("Add newfile.txt");
      });

      it("should generate commit message from staged changes", async () => {
        const testDir = "/tmp/git-commit-push-staged-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "staged content" > staged-file.txt',
            // Stage the changes BEFORE calling gitCommitAndPushBranch
            "git add staged-file.txt",
          ].join(" && "),
          { cwd: testDir },
        );

        // Verify changes are staged but not committed
        const statusOutput = await sandbox.runCommand(
          "git status --porcelain",
          {
            cwd: testDir,
          },
        );
        expect(statusOutput).toContain("A  staged-file.txt");

        // Run gitCommitAndPushBranch when changes are already staged
        const result = await gitCommitAndPushBranch({
          session: sandbox,
          args: {
            githubAppName: "test-app",
            baseBranch: "main",
            generateCommitMessage: async (diff: string) => {
              // This is the key assertion: the diff should contain the staged changes
              // even though they're already staged
              expect(diff).toContain("staged-file.txt");
              expect(diff).toContain("+staged content");
              return "Add staged file";
            },
            repoRoot: testDir,
          },
          enableIntegrityChecks: false,
        });

        // Should return branch name without error
        expect(result).toEqual({ branchName: "feature-branch" });

        // Verify the commit was made with the correct message
        const localLog = await sandbox.runCommand("git log --oneline -n 1", {
          cwd: testDir,
        });
        expect(localLog).toContain("Add staged file");

        // Verify the commit was pushed to remote
        await sandbox.runCommand("git fetch", { cwd: testDir });
        const remoteBranches = await sandbox.runCommand("git branch -r", {
          cwd: testDir,
        });
        expect(remoteBranches).toContain("origin/feature-branch");
      });

      it("should push when local branch is ahead after rebase", async () => {
        const testDir = "/tmp/git-commit-push-rebase-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
            "git push -u origin feature-branch",
          ].join(" && "),
          { cwd: testDir },
        );

        // Simulate another branch being merged to main
        await sandbox.runCommand(
          [
            "git checkout main",
            'echo "main update" > main-update.txt',
            "git add main-update.txt",
            'git commit -m "Update on main"',
            "git push origin main",
          ].join(" && "),
          { cwd: testDir },
        );

        // Rebase feature branch onto updated main
        await sandbox.runCommand(
          [
            "git checkout feature-branch",
            "git fetch origin",
            "git rebase origin/main",
          ].join(" && "),
          { cwd: testDir },
        );

        // Verify local is ahead of remote
        const aheadStatus = await sandbox.runCommand("git status -sb", {
          cwd: testDir,
        });
        expect(aheadStatus).toContain("ahead");

        // Run gitCommitAndPushBranch when there are no new changes
        const result = await gitCommitAndPushBranch({
          session: sandbox,
          args: {
            githubAppName: "test-app",
            baseBranch: "main",
            generateCommitMessage: async () => "Test commit",
            repoRoot: testDir,
          },
          enableIntegrityChecks: false,
        });

        // Should return branch name without error
        expect(result).toEqual({ branchName: "feature-branch" });

        // Verify the branch was pushed and is now up to date
        await sandbox.runCommand("git fetch", { cwd: testDir });
        const statusAfter = await sandbox.runCommand("git status -sb", {
          cwd: testDir,
        });
        expect(statusAfter).not.toContain("ahead");

        // Verify the rebased commit is in the remote
        const remoteLog = await sandbox.runCommand(
          "git log --oneline origin/feature-branch",
          { cwd: testDir },
        );
        expect(remoteLog).toContain("Add feature");
        expect(remoteLog).toContain("Update on main");
      });

      it("should push when local branch is ahead of base branch but remote branch does not exist", async () => {
        const testDir = "/tmp/git-commit-push-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();

        await createTestRepo(sandbox, testDir);

        // Setup remote
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add origin ${remoteDir}`,
            "git push -u origin main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Run gitCommitAndPushBranch
        const result = await gitCommitAndPushBranch({
          session: sandbox,
          args: {
            githubAppName: "test-app",
            baseBranch: "main",
            repoRoot: testDir,
            generateCommitMessage: async () => "Test commit",
          },
          enableIntegrityChecks: false,
        });
        expect(result).toEqual({ branchName: "feature-branch" });

        // Verify the file is in the remote
        const remoteLog = await sandbox.runCommand(
          "git log --oneline origin/feature-branch -n 1",
          { cwd: testDir },
        );
        expect(remoteLog).toContain("Add feature");
      });
    });

    describe("git-pull-upstream", () => {
      it("should work", async () => {
        const testDir = "/tmp/git-pull-upstream-test-" + nanoid();
        await createTestRepo(sandbox, testDir);

        // Should not throw when no upstream remote exists
        await gitPullUpstream(sandbox, { repoRoot: testDir });

        // Create a remote
        const remoteDir = "/tmp/remote-repo-" + nanoid();
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            `git remote add upstream ${remoteDir}`,
            "git push -u upstream main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
            "git push -u upstream feature-branch",
          ].join(" && "),
          { cwd: testDir },
        );

        // Try to pull when already up to date - should not throw
        await gitPullUpstream(sandbox, { repoRoot: testDir });

        // Simulate another user pushing to the same branch
        const otherUserDir = "/tmp/other-user-" + nanoid();
        await sandbox.runCommand(`mkdir -p ${otherUserDir}`);
        await sandbox.runCommand(
          [
            `git clone ${remoteDir} .`,
            'git config user.email "other@example.com"',
            'git config user.name "Other User"',
            "git checkout feature-branch",
            'echo "other user content" > other.txt',
            "git add other.txt",
            'git commit -m "Other user commit"',
            "git push",
          ].join(" && "),
          { cwd: otherUserDir },
        );

        // Pull the changes
        await gitPullUpstream(sandbox, { repoRoot: testDir });

        // Verify the file was pulled
        const fileExists = await sandbox.runCommand("ls other.txt", {
          cwd: testDir,
        });
        expect(fileExists.trim()).toBe("other.txt");
      });

      it("should not throw on non-fast-forward when branches have diverged", async () => {
        const testDir = "/tmp/git-pull-upstream-test-" + nanoid();
        const remoteDir = "/tmp/remote-repo-" + nanoid();
        const otherUserDir = "/tmp/other-user-" + nanoid();

        await createTestRepo(sandbox, testDir);

        const currentCommit = (
          await sandbox.runCommand("git rev-parse HEAD", { cwd: testDir })
        ).trim();

        // Setup remote as upstream
        await sandbox.runCommand(`mkdir -p ${remoteDir}`);
        await sandbox.runCommand("git init --bare", { cwd: remoteDir });
        await sandbox.runCommand(
          [
            "git remote add upstream " + remoteDir,
            "git push -u upstream main",
            "git checkout -b feature-branch",
            'echo "feature content" > feature.txt',
            "git add feature.txt",
            'git commit -m "Add feature"',
            "git push -u upstream feature-branch",
          ].join(" && "),
          {
            cwd: testDir,
          },
        );

        // Simulate another user pushing different changes
        await sandbox.runCommand(`mkdir -p ${otherUserDir}`);
        await sandbox.runCommand(
          [
            `git clone ${remoteDir} .`,
            'git config user.email "other@example.com"',
            'git config user.name "Other User"',
            "git checkout feature-branch",
            'echo "other user content" > other.txt',
            "git add other.txt",
            'git commit -m "Other user commit"',
            "git push",
          ].join(" && "),
          { cwd: otherUserDir },
        );

        // Make local changes that will cause divergence
        await sandbox.runCommand(
          [
            'echo "my local content" > local.txt',
            "git add local.txt",
            'git commit -m "Local changes"',
          ].join(" && "),
          { cwd: testDir },
        );

        // Try to pull - should fail because of non-fast-forward
        await gitPullUpstream(sandbox, { repoRoot: testDir });

        const currentCommit2 = (
          await sandbox.runCommand("git rev-parse HEAD", { cwd: testDir })
        ).trim();
        expect(currentCommit2).not.toBe(currentCommit);
      });
    });
  });

  describe("provider", () => {
    it("homeDir & repoDir work", async () => {
      const result = await sandbox.runCommand("cd && pwd");
      expect(result.trim()).toBe("/" + sandbox.homeDir);
      const result2 = await sandbox.runCommand("pwd");
      expect(result2.trim()).toBe(
        "/" + [sandbox.homeDir, sandbox.repoDir].join("/"),
      );
    });

    it("hibernate & resume works", async () => {
      await sandbox.hibernate();
      sandbox = await getOrCreateSandbox(
        sandbox.sandboxId,
        getCreateSandboxOptions(providerName),
      );
      const result = await sandbox.runCommand("echo 'resumed'");
      expect(result.trim()).toBe("resumed");
    });

    it("runCommand works", async () => {
      const result = await sandbox.runCommand("echo 'Hello, world!'");
      expect(result).toBe("Hello, world!\n");
    });

    it("runCommand with timeout errors", async () => {
      await expect(
        sandbox.runCommand("sleep 10", { timeoutMs: 1000 }),
      ).rejects.toThrow(/Command timed out/);
    });

    it("runCommand should run bash", async () => {
      const result = await sandbox.runCommand('echo "Shell is: $0"');
      expect(result).toContain("bash");
    });

    it("runCommand works with set -o pipefail", async () => {
      const result = await sandbox.runCommand(
        "set -o pipefail; echo ''Hello, world!'' | head -n 50",
      );
      expect(result).toContain("Hello, world!");
      await expect(
        sandbox.runCommand("set -o pipefail; false | head -n 50"),
      ).rejects.toThrow(/Command failed with exit code 1/);
    });

    it("runCommand throws on error", async () => {
      await expect(sandbox.runCommand("INVALID_COMMAND")).rejects.toThrow();
    });

    it("runCommand default cwd is a git repo", async () => {
      const result = await sandbox.runCommand("test -d .git && echo 'true'");
      expect(result).toBe("true\n");
    });

    it("runCommand with cwd works", async () => {
      const testFileName = `test-${nanoid()}.txt`;
      const testFilePath = `/tmp/${testFileName}`;
      await sandbox.runCommand(`echo "Hello, world!" > ${testFilePath}`);
      const result = await sandbox.runCommand(
        `test -f ${testFilePath} && echo 'true'`,
        {
          cwd: "/tmp",
        },
      );
      expect(result).toBe("true\n");
    });

    it("runBackgroundCommand works", async () => {
      let capturedOutput = "";
      await new Promise<void>((resolve) => {
        sandbox.runBackgroundCommand("echo 'Hello, world!' && echo 'DONE'", {
          onOutput: (data) => {
            console.log("onOutput", data);
            capturedOutput += data;
            if (capturedOutput.includes("DONE")) {
              resolve();
            }
          },
        });
      });
      expect(capturedOutput).toContain("Hello, world!");
    });

    it("runBackgroundCommand passes environment variables correctly", async () => {
      // Create a promise that resolves when the background command completes
      let capturedOutput = "";
      await new Promise<void>((resolve) => {
        sandbox.runBackgroundCommand(
          `echo "TEST_VAR1=$TEST_VAR1" && echo "DONE"`,
          {
            env: { TEST_VAR1: "value1" },
            onOutput: (data) => {
              capturedOutput += data;
              if (capturedOutput.includes("DONE")) {
                resolve();
              }
            },
          },
        );
      });
      expect(capturedOutput).toContain("TEST_VAR1=value1");
    });

    it("readTextFile and writeTextFile works", async () => {
      const testFileName = `/tmp/test-${nanoid()}.txt`;
      await sandbox.runCommand(`echo "Hello, world!" > ${testFileName}`);
      const result = await sandbox.readTextFile(testFileName);
      expect(result).toBe("Hello, world!\n");

      await sandbox.writeTextFile(testFileName, "Hello, world 2!");
      const result2 = await sandbox.readTextFile(testFileName);
      expect(result2).toBe("Hello, world 2!");
    });

    it("writeFile works", async () => {
      const testFileName = `/tmp/test-${nanoid()}.txt`;
      await sandbox.writeFile(
        testFileName,
        new TextEncoder().encode("Hello, world!"),
      );
      const result = await sandbox.readTextFile(testFileName);
      expect(result).toBe("Hello, world!");
    });
  });

  it(
    "env vars are preserved across hibernation",
    async () => {
      const result = await sandbox.runCommand("echo $TEST_VAR1");
      expect(result).toBe("value1\n");
      await sandbox.hibernate();
      const resumedSandbox = await getOrCreateSandbox(
        sandbox.sandboxId,
        getCreateSandboxOptions(providerName),
      );
      const result2 = await resumedSandbox.runCommand("echo $TEST_VAR1");
      expect(result2).toBe("value1\n");

      const result3 = await resumedSandbox.runCommand(
        `bash -c ${bashQuote(`set -o pipefail; echo $TEST_VAR1 | head -n 50`)}`,
      );
      expect(result3).toBe("value1\n");
    },
    60 * 1000, // Give more time to hibernate and resume the sandbox
  );

  it("should configure .profile with ulimit and bashrc sourcing", async () => {
    const profileContent = await sandbox.readTextFile(
      `/${sandbox.homeDir}/.profile`,
    );
    expect(profileContent).toMatch(/^ulimit -c 0$/m);
    expect(profileContent).toMatch(
      /^if \[ -f ~\/\.bashrc \]; then \. ~\/\.bashrc; fi$/m,
    );
  });
});

async function createTestRepo(sandbox: ISandboxSession, tmpDir: string) {
  await sandbox.runCommand(`mkdir -p ${tmpDir}`);
  await sandbox.runCommand(
    [
      "git init -b main",
      "git config user.email 'test@example.com'",
      'git config user.name "Test User"',
      'echo "initial content" > initial.txt',
      "git add initial.txt",
      'git commit -m "Initial commit"',
    ].join(" && "),
    { cwd: tmpDir },
  );
}

async function sleepUntil(
  condition: () => Promise<boolean>,
  maxWaitMs: number = 2000,
) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    if (await condition()) {
      return;
    }
  }
  throw new Error("Condition not met within timeout period");
}
