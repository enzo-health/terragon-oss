import { describe, it, expect, vi } from "vitest";
import { parse as tomlParse } from "@iarna/toml";
import {
  setupSandboxOneTime,
  gitCloneRepo,
  setupSandboxEveryTime,
  launchSetupScriptInBackground,
} from "./setup";
import { CreateSandboxOptions } from "./types";
import { MockSession } from "./providers/mock-provider";

// Mock the installDaemon function
vi.mock("./daemon", () => ({
  installDaemon: vi.fn().mockResolvedValue(undefined),
  updateDaemonIfOutdated: vi.fn().mockResolvedValue(undefined),
  restartDaemonIfNotRunning: vi.fn().mockResolvedValue(undefined),
  MCP_SERVER_FILE_PATH: "/tmp/terry-mcp-server.mjs",
}));

import { installDaemon, restartDaemonIfNotRunning } from "./daemon";

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

describe("sandbox-setup", () => {
  describe("setupSandboxOneTime", () => {
    it("should create a new branch when createNewBranch is true", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = { ...defaultOptions, repoBaseBranchName: "develop" };
      await setupSandboxOneTime(session, options);

      // Should have git clone with branch specification and blobless flags
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'develop' https://github.com/owner/repo.git repo",
        { cwd: "/root" },
      );

      // Should create new branch with generated name (terragon/[6-char-id]-[6-char-id] in test env)
      const runCommandCalls = runCommandSpy.mock.calls;
      const checkoutNewBranchCall = runCommandCalls.find((call) =>
        call[0].match(/git checkout -b 'terragon\/[a-z0-9]{6}-[a-z0-9]{6}'/),
      );
      expect(checkoutNewBranchCall).toBeDefined();

      // Verify order: clone -> create new branch
      const cloneIndex = runCommandCalls.findIndex((call) =>
        call[0].includes("git clone"),
      );
      const checkoutNewBranchIndex = runCommandCalls.findIndex((call) =>
        call[0].match(/git checkout -b 'terragon\/[a-z0-9]{6}-[a-z0-9]{6}'/),
      );
      expect(checkoutNewBranchIndex).toBeGreaterThan(cloneIndex);
    });

    it("clones the repo onto the Daytona workspace volume when enabled", async () => {
      const session = new MockSession("mock-sandbox");
      const writes = new Map<string, string>();
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      vi.spyOn(session, "writeTextFile").mockImplementation(
        async (filePath, content) => {
          writes.set(filePath, content);
        },
      );

      await setupSandboxOneTime(session, {
        ...defaultOptions,
        sandboxProvider: "daytona",
        daytonaVolume: {
          volumeName: "terragon-workspaces",
          cacheMountPath: "/mnt/terragon/cache",
          cacheSubpath: "users/user-123/cache",
          workspaceMountPath: "/mnt/terragon/workspace",
          workspaceSubpath:
            "users/user-123/environments/env-123/repos/owner_repo/threads/thread-1",
          repoOnVolume: true,
        },
      });

      expect(writes.get("/etc/profile.d/00-terragon-volume.sh")).toContain(
        "PNPM_STORE_DIR=/mnt/terragon/cache/pnpm-store",
      );
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'main' https://github.com/owner/repo.git '/mnt/terragon/workspace/repo'",
        { cwd: "/root" },
      );
      expect(runCommandSpy).toHaveBeenCalledWith(
        "ln -s '/mnt/terragon/workspace/repo' '/root/repo'",
        { cwd: "/" },
      );
    });

    it("moves a snapshot checkout onto the Daytona workspace volume when enabled", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      await setupSandboxOneTime(session, {
        ...defaultOptions,
        snapshotTemplateId: "snapshot-template",
        sandboxProvider: "daytona",
        daytonaVolume: {
          volumeName: "terragon-workspaces",
          cacheMountPath: "/mnt/terragon/cache",
          cacheSubpath: "users/user-123/cache",
          workspaceMountPath: "/mnt/terragon/workspace",
          workspaceSubpath:
            "users/user-123/environments/env-123/repos/owner_repo/threads/thread-1",
          repoOnVolume: true,
        },
      });

      const moveCommand = runCommandSpy.mock.calls.find((call) =>
        call[0].includes(
          "rm -rf '/mnt/terragon/workspace/repo' && cp -a '/root/repo' '/mnt/terragon/workspace/repo'",
        ),
      );
      expect(moveCommand).toBeDefined();
      expect(moveCommand?.[0]).toContain(
        "ln -s '/mnt/terragon/workspace/repo' '/root/repo'",
      );
      expect(runCommandSpy).toHaveBeenCalledWith(
        'git remote set-url origin "https://${GITHUB_ACCESS_TOKEN}@github.com/owner/repo.git"',
        { env: { GITHUB_ACCESS_TOKEN: "test-token" } },
      );
    });

    it("reuses an existing Daytona snapshot volume repo without cleaning it", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (command) => {
          if (command.includes("test -d '/mnt/terragon/workspace/repo/.git'")) {
            return "exists\n";
          }
          return "";
        });
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      await setupSandboxOneTime(session, {
        ...defaultOptions,
        snapshotTemplateId: "snapshot-template",
        sandboxProvider: "daytona",
        daytonaVolume: {
          volumeName: "terragon-workspaces",
          cacheMountPath: "/mnt/terragon/cache",
          cacheSubpath: "users/user-123/cache",
          workspaceMountPath: "/mnt/terragon/workspace",
          workspaceSubpath:
            "users/user-123/environments/env-123/repos/owner_repo/threads/thread-1",
          repoOnVolume: true,
        },
      });

      const commands = runCommandSpy.mock.calls.map((call) => call[0]);
      expect(commands).toContain(
        "mkdir -p '/mnt/terragon/workspace' && rm -rf '/root/repo' && ln -s '/mnt/terragon/workspace/repo' '/root/repo'",
      );
      expect(
        commands.some((command) =>
          command.includes("cp -a '/root/repo' '/mnt/terragon/workspace/repo'"),
        ),
      ).toBe(false);
      expect(
        commands.some((command) => command.includes("git checkout -b")),
      ).toBe(false);
      expect(commands.some((command) => command === "git clean -fxd")).toBe(
        false,
      );
    });

    it("reuses an existing Daytona volume repo without deleting workspace state", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (command) => {
          if (command.includes("test -d '/mnt/terragon/workspace/repo/.git'")) {
            return "exists\n";
          }
          return "";
        });
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      await setupSandboxOneTime(session, {
        ...defaultOptions,
        sandboxProvider: "daytona",
        daytonaVolume: {
          volumeName: "terragon-workspaces",
          cacheMountPath: "/mnt/terragon/cache",
          cacheSubpath: "users/user-123/cache",
          workspaceMountPath: "/mnt/terragon/workspace",
          workspaceSubpath:
            "users/user-123/environments/env-123/repos/owner_repo/threads/thread-1",
          repoOnVolume: true,
        },
      });

      const commands = runCommandSpy.mock.calls.map((call) => call[0]);
      expect(commands).toContain(
        "rm -rf /root/repo && ln -s '/mnt/terragon/workspace/repo' '/root/repo'",
      );
      expect(commands.some((command) => command.includes("git clone"))).toBe(
        false,
      );
      expect(
        commands.some((command) => command.includes("git checkout -b")),
      ).toBe(false);
      expect(commands.some((command) => command === "git clean -fxd")).toBe(
        false,
      );
      expect(
        commands.some((command) =>
          command.includes("rm -rf '/mnt/terragon/workspace/repo'"),
        ),
      ).toBe(false);
    });

    it("should not checkout base branch if not specified", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = { ...defaultOptions, repoBaseBranchName: "" };
      await setupSandboxOneTime(session, options);

      const runCommandCalls = runCommandSpy.mock.calls;

      // Should not have checkout base branch command (empty string)
      expect(
        runCommandCalls.find((call) => call[0] === "git checkout "),
      ).toBeUndefined();

      // But should still create new branch with hash
      expect(
        runCommandCalls.find((call) =>
          call[0].match(/git checkout -b 'terragon\/[a-z0-9]{6}-[a-z0-9]{6}'/),
        ),
      ).toBeDefined();
    });

    it("should not create new branch if createNewBranch is false", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = { ...defaultOptions, createNewBranch: false };
      await setupSandboxOneTime(session, options);

      // Should clone with branch specification and blobless flags (no separate checkout needed)
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'main' https://github.com/owner/repo.git repo",
        { cwd: "/root" },
      );

      const runCommandCalls = runCommandSpy.mock.calls;

      // Should not create new branch
      expect(
        runCommandCalls.find((call) =>
          call[0].includes("git checkout -b 'terragon/"),
        ),
      ).toBeUndefined();
    });
  });

  describe("gitCloneRepo", () => {
    it("should clone repo", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      const options = { ...defaultOptions, repoBaseBranchName: "feature/test" };
      await gitCloneRepo(session, options);
      // Should clone the repo with branch specification and blobless flags
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'feature/test' https://github.com/owner/repo.git repo",
        { cwd: "/root" },
      );
    });

    it("should not checkout branch if not specified", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      const options = { ...defaultOptions, repoBaseBranchName: "" };
      await gitCloneRepo(session, options);

      // Should clone the repo without branch specification but with blobless flags
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules https://github.com/owner/repo.git repo",
        { cwd: "/root" },
      );
    });
  });

  describe("setupSandboxEveryTime", () => {
    it("should create AGENTS.md for codex agent with customSystemPrompt", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customPrompt = "This is a custom system prompt for Codex";
      const options = {
        ...defaultOptions,
        agent: "codex" as const,
        customSystemPrompt: customPrompt,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      // Should ensure ~/.codex directory exists
      expect(runCommandSpy).toHaveBeenCalledWith("mkdir -p /home/user/.codex", {
        cwd: "/",
      });
      // Should write custom system prompt to ~/.codex/AGENTS.md for codex agent
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.codex/AGENTS.md",
        customPrompt,
      );
      // Should set proper permissions (batched chmod)
      expect(runCommandSpy).toHaveBeenCalledWith(
        "chmod 644 /home/user/.codex/AGENTS.md && chmod 644 /home/user/.codex/config.toml",
        { cwd: "/" },
      );
    });

    it("should write codex config using publicUrl", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd === "cd && pwd") return "/home/user";
        return "";
      });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const options = {
        ...defaultOptions,
        agent: "codex" as const,
        publicUrl: "https://fallback.example.com",
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      const configCall = writeTextFileSpy.mock.calls.find(
        ([path]) => path === "/home/user/.codex/config.toml",
      );

      expect(configCall).toBeDefined();
      const configContents = configCall?.[1];
      expect(typeof configContents).toBe("string");
      const parsed = tomlParse(configContents as string) as any;
      expect(parsed.model_providers.terry).toEqual({
        name: "terry",
        base_url: "https://fallback.example.com/api/proxy/openai/v1",
        wire_api: "responses",
        env_http_headers: { "X-Daemon-Token": "DAEMON_TOKEN" },
      });
    });
    it("should create AGENT.md for amp agent with customSystemPrompt", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customPrompt = "This is a custom system prompt for Amp";
      const options = {
        ...defaultOptions,
        agent: "amp" as const,
        customSystemPrompt: customPrompt,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      // Should create ~/.config directory
      expect(runCommandSpy).toHaveBeenCalledWith(
        "mkdir -p /home/user/.config",
        {
          cwd: "/",
        },
      );
      // Should write custom system prompt to ~/.config/AGENTS.md for amp agent
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.config/AGENTS.md",
        customPrompt,
      );
      // Should set proper permissions (batched chmod)
      expect(runCommandSpy).toHaveBeenCalledWith(
        "chmod 644 /home/user/.config/AGENTS.md && chmod 644 /home/user/.config/amp/settings.json",
        { cwd: "/" },
      );
    });

    it("should create CLAUDE.md for claudeCode agents with customSystemPrompt", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd === "cd && pwd") return "/home/user";
        return "";
      });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customPrompt = "This is a custom system prompt for Claude";
      const options = {
        ...defaultOptions,
        agent: "claudeCode" as const,
        customSystemPrompt: customPrompt,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });
      // Should write custom system prompt to ~/.claude/CLAUDE.md for non-amp agents
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.claude/CLAUDE.md",
        customPrompt,
      );
    });

    it("should disable local quality hooks for claudeCode when skipLocalQualityChecks is true", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const options = {
        ...defaultOptions,
        agent: "claudeCode" as const,
        skipLocalQualityChecks: true,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      const settingsCall = writeTextFileSpy.mock.calls.find(
        ([filePath]) => filePath === "/home/user/.claude/settings.json",
      );
      expect(settingsCall).toBeDefined();
      const parsedSettings = JSON.parse((settingsCall?.[1] as string) ?? "{}");
      expect(parsedSettings?.hooks?.Stop).toEqual([]);

      expect(writeTextFileSpy).not.toHaveBeenCalledWith(
        "/tmp/terragon-quality-check.sh",
        expect.any(String),
      );
      expect(runCommandSpy).toHaveBeenCalledWith(
        "rm -f /tmp/terragon-quality-check.sh",
        { cwd: "/" },
      );
    });

    it("should not run the setup script during resume setup", async () => {
      const session = new MockSession("mock-sandbox");
      vi.mocked(installDaemon).mockClear();
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });

      await setupSandboxEveryTime({
        session,
        options: {
          ...defaultOptions,
          setupScript: "echo hi",
        },
        isCreatingSandbox: false,
      });

      expect(
        runCommandSpy.mock.calls.some(([cmd]) =>
          cmd.includes("/tmp/terragon-setup-custom.sh"),
        ),
      ).toBe(false);
      expect(installDaemon).not.toHaveBeenCalled();
    });

    it("should skip sandbox-agent probing during fast resume", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      vi.mocked(restartDaemonIfNotRunning).mockClear();

      await setupSandboxEveryTime({
        session,
        options: {
          ...defaultOptions,
          fastResume: true,
          environmentVariables: [
            {
              key: "SANDBOX_AGENT_BASE_URL",
              value: "http://127.0.0.1:2468",
            },
          ],
        },
        isCreatingSandbox: false,
      });

      expect(vi.mocked(restartDaemonIfNotRunning)).toHaveBeenCalledWith({
        session,
        options: expect.objectContaining({
          fastResume: true,
        }),
      });
      expect(
        runCommandSpy.mock.calls.some(
          ([cmd]) =>
            cmd.includes("sandbox-agent") ||
            cmd.includes("/v1/health") ||
            cmd.includes("/v1/acp") ||
            cmd.includes("/v1/rpc"),
        ),
      ).toBe(false);
    });

    it("should refresh codex auth files during fast resume", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd === "cd && pwd") return "/home/user";
        return "";
      });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      await setupSandboxEveryTime({
        session,
        options: {
          ...defaultOptions,
          agent: "codex",
          fastResume: true,
          agentCredentials: {
            type: "json-file",
            contents: '{"tokens":{"access_token":"fresh-access-token"}}',
          },
        },
        isCreatingSandbox: false,
      });

      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.codex/auth.json",
        '{"tokens":{"access_token":"fresh-access-token"}}',
      );
    });

    it("should remove stale codex auth files during fast resume when credentials are unavailable", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      await setupSandboxEveryTime({
        session,
        options: {
          ...defaultOptions,
          agent: "codex",
          fastResume: true,
          agentCredentials: null,
        },
        isCreatingSandbox: false,
      });

      expect(runCommandSpy).toHaveBeenCalledWith(
        "rm -f /home/user/.codex/auth.json",
        { cwd: "/" },
      );
    });

    it("should still probe sandbox-agent while creating a fast resume sandbox", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd.includes("/v1/acp")) {
            return "";
          }
          return "RUNNING";
        });

      await setupSandboxEveryTime({
        session,
        options: {
          ...defaultOptions,
          fastResume: true,
          environmentVariables: [
            {
              key: "SANDBOX_AGENT_BASE_URL",
              value: "http://127.0.0.1:2468",
            },
          ],
        },
        isCreatingSandbox: true,
      });

      expect(
        runCommandSpy.mock.calls.some(([cmd]) => cmd.includes("/v1/health")),
      ).toBe(true);
      expect(
        runCommandSpy.mock.calls.some(([cmd]) => cmd.includes("/v1/acp")),
      ).toBe(true);
    });
  });

  describe("environment setup script", () => {
    it("should run environment setup script when provided", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customSetupScript = `#!/bin/bash
echo "Running custom setup"
npm install
npm run build`;

      const options = {
        ...defaultOptions,
        setupScript: customSetupScript,
      };

      await setupSandboxOneTime(session, options);

      // Should write the custom setup script to a temporary file
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/tmp/terragon-setup-custom.sh",
        customSetupScript,
      );

      // Should make the script executable
      expect(runCommandSpy).toHaveBeenCalledWith(
        "chmod +x /tmp/terragon-setup-custom.sh",
      );

      // Should execute the custom setup script
      const executeScriptCall = runCommandSpy.mock.calls.find((call) =>
        call[0].includes("bash -x /tmp/terragon-setup-custom.sh"),
      );
      expect(executeScriptCall).toBeDefined();
      expect(executeScriptCall?.[1]).toMatchObject({
        timeoutMs: expect.any(Number),
        env: expect.any(Object),
      });
    });

    it("should run repository setup script when no environment script provided", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = {
        ...defaultOptions,
        setupScript: null, // No environment script
      };

      await setupSandboxOneTime(session, options);

      // Should check for and run terragon-setup.sh from the repository
      const repoSetupScriptCall = runCommandSpy.mock.calls.find((call) =>
        call[0].includes("if [ -f terragon-setup.sh ]"),
      );
      expect(repoSetupScriptCall).toBeDefined();
      expect(repoSetupScriptCall?.[0]).toContain("chmod +x terragon-setup.sh");
      expect(repoSetupScriptCall?.[0]).toContain("bash -x ./terragon-setup.sh");
    });

    it("should skip setup script when skipSetupScript is true", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = {
        ...defaultOptions,
        skipSetupScript: true,
      };

      await setupSandboxOneTime(session, options);

      // Should not run any setup script
      const setupScriptCalls = runCommandSpy.mock.calls.filter(
        (call) =>
          call[0].includes("terragon-setup") || call[0].includes("setup.sh"),
      );
      expect(setupScriptCalls).toHaveLength(0);
    });

    it("should pass environment variables to setup script", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      const envVars = [
        { key: "API_KEY", value: "secret123" },
        { key: "DATABASE_URL", value: "postgres://localhost" },
      ];

      const options = {
        ...defaultOptions,
        setupScript: "echo $API_KEY",
        environmentVariables: envVars,
      };

      await setupSandboxOneTime(session, options);

      // Find the setup script execution call
      const setupScriptCall = runCommandSpy.mock.calls.find((call) =>
        call[0].includes("bash -x /tmp/terragon-setup-custom.sh"),
      );

      expect(setupScriptCall?.[1]?.env).toEqual({
        API_KEY: "secret123",
        DATABASE_URL: "postgres://localhost",
        TERRAGON: "true",
        GH_TOKEN: "test-token",
        TERM: "xterm",
        CI: "true",
      });
    });

    it("should capture setup script output", async () => {
      const session = new MockSession("mock-sandbox");

      vi.spyOn(session, "runCommand").mockImplementation(
        async (cmd, options) => {
          if (cmd.includes("bash -x /tmp/terragon-setup-custom.sh")) {
            // Simulate output callbacks
            options?.onStdout?.("Installing dependencies...\n");
            options?.onStdout?.("Dependencies installed!\n");
            options?.onStderr?.("Warning: peer dependency\n");
          }
          return "";
        },
      );
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      // Spy on console.log to capture the output
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      const options = {
        ...defaultOptions,
        setupScript: "npm install",
      };

      await setupSandboxOneTime(session, options);

      // Check that output was logged
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Setup script output:",
        expect.stringContaining("Installing dependencies"),
      );

      consoleLogSpy.mockRestore();
    });

    it("should handle setup script errors gracefully", async () => {
      const session = new MockSession("mock-sandbox");

      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd.includes("bash -x /tmp/terragon-setup-custom.sh")) {
          throw new Error("Command failed with exit code 1");
        }
        return "";
      });
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      const options = {
        ...defaultOptions,
        setupScript: "exit 1",
      };

      // Should throw an error with setup script failure message
      await expect(setupSandboxOneTime(session, options)).rejects.toThrow(
        "Setup script failed",
      );
    });

    it("should run daemon install and setup script", async () => {
      const order: string[] = [];

      // installDaemon resolves after a tick — simulates async work
      vi.mocked(installDaemon).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("daemon-done");
      });

      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd.includes("bash -x /tmp/terragon-setup-custom.sh")) {
          order.push("setup-script-ran");
        }
        return "";
      });
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      await setupSandboxOneTime(session, {
        ...defaultOptions,
        setupScript: "echo hi",
      });

      // Both must have run
      expect(order).toContain("daemon-done");
      expect(order).toContain("setup-script-ran");
    });

    it("should not run setup script when skipSetupScript is true, waiting for daemon only", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async () => "");
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      await setupSandboxOneTime(session, {
        ...defaultOptions,
        skipSetupScript: true,
        setupScript: "echo hi",
      });

      // installDaemon mock should still have been called
      expect(installDaemon).toHaveBeenCalled();
    });
  });

  describe("launchSetupScriptInBackground", () => {
    function setupSpies() {
      const session = new MockSession("mock-sandbox");
      const writes = new Map<string, string>();
      const commands: Array<{ command: string; env?: Record<string, string> }> =
        [];
      vi.spyOn(session, "writeTextFile").mockImplementation(
        async (path, content) => {
          writes.set(path, content);
        },
      );
      vi.spyOn(session, "runCommand").mockImplementation(
        async (command, options) => {
          commands.push({ command, env: options?.env });
          return "";
        },
      );
      return { session, writes, commands };
    }

    const SENTINEL = "/root/.terragon/setup-complete";
    const RUNNER = "/tmp/terragon-bg-setup-runner.sh";
    const SHIM = "/root/.terragon/bin/terragon-barrier-shim.sh";
    const INSTALLER = "/tmp/terragon-bg-install-barrier.sh";

    it("installs the barrier shim that waits on the sentinel then execs the real tool", async () => {
      const { session, writes } = setupSpies();
      await launchSetupScriptInBackground({
        session,
        options: {
          environmentVariables: [],
          githubAccessToken: "tok",
          agentCredentials: null,
          setupScript: null,
        },
      });

      const shim = writes.get(SHIM);
      expect(shim).toBeDefined();
      expect(shim).toContain(`while [ ! -f ${SENTINEL} ]; do sleep 1; done`);
      expect(shim).toContain('exec "$real" "$@"');
      // Fails loudly when setup exited non-zero.
      expect(shim).toContain('if [ "$code" != "0" ]; then');
    });

    it("symlinks pnpm/npm/yarn/node and prepends the bin dir to PATH", async () => {
      const { session, writes } = setupSpies();
      await launchSetupScriptInBackground({
        session,
        options: {
          environmentVariables: [],
          githubAccessToken: "tok",
          agentCredentials: null,
          setupScript: null,
        },
      });

      const installer = writes.get(INSTALLER);
      expect(installer).toBeDefined();
      expect(installer).toContain("for tool in pnpm npm yarn node;");
      expect(installer).toContain(`ln -sf ${SHIM} /root/.terragon/bin/$tool`);
      expect(installer).toContain("profile.d/00-terragon-setup-barrier.sh");
    });

    it("runs the repo terragon-setup.sh and touches the sentinel on completion", async () => {
      const { session, writes } = setupSpies();
      await launchSetupScriptInBackground({
        session,
        options: {
          environmentVariables: [],
          githubAccessToken: "tok",
          agentCredentials: null,
          setupScript: null,
        },
      });

      const runner = writes.get(RUNNER);
      expect(runner).toBeDefined();
      expect(runner).toContain("bash -x ./terragon-setup.sh");
      expect(runner).toContain(
        `echo "$code" > /root/.terragon/setup-exit-code`,
      );
      expect(runner).toContain(`touch ${SENTINEL}`);
    });

    it("launches the runner detached and returns without awaiting setup", async () => {
      const { session, commands } = setupSpies();
      await launchSetupScriptInBackground({
        session,
        options: {
          environmentVariables: [{ key: "FOO", value: "bar" }],
          githubAccessToken: "tok",
          agentCredentials: null,
          setupScript: null,
        },
      });

      const launch = commands.find((c) => c.command.includes("nohup"));
      expect(launch).toBeDefined();
      expect(launch!.command).toContain(`nohup bash ${RUNNER}`);
      // `&` detaches; the call returns immediately.
      expect(launch!.command).toContain("&");
      // Setup env (CI + user vars) is passed to the launching shell so the
      // detached child inherits it.
      expect(launch!.env?.CI).toBe("true");
      expect(launch!.env?.FOO).toBe("bar");
    });

    it("runs a custom setup script when provided", async () => {
      const { session, writes } = setupSpies();
      await launchSetupScriptInBackground({
        session,
        options: {
          environmentVariables: [],
          githubAccessToken: "tok",
          agentCredentials: null,
          setupScript: "echo custom",
        },
      });

      expect(writes.get("/tmp/terragon-setup-custom.sh")).toBe("echo custom");
      expect(writes.get(RUNNER)).toContain(
        "bash -x /tmp/terragon-setup-custom.sh",
      );
    });
  });
});
