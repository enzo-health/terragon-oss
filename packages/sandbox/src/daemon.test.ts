import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  installDaemon,
  sendMessage,
  restartDaemonIfNotRunning,
  updateDaemonIfOutdated,
} from "./daemon";
import type { ISandboxSession } from "./types";
import type { CreateSandboxOptions } from "./types";

// Mock the bundled imports
vi.mock("@terragon/bundled", () => ({
  daemonAsStr: "mock-daemon-content",
  mcpServerAsStr: "mock-mcp-server-content",
}));

describe("daemon installation", () => {
  let mockSession: ISandboxSession;
  let writtenFiles: Record<string, string> = {};
  let executedCommands: string[] = [];

  beforeEach(() => {
    writtenFiles = {};
    executedCommands = [];

    mockSession = {
      sandboxId: "test-sandbox-id",
      sandboxProvider: "docker",
      repoDir: "repo",
      homeDir: "root",
      hibernate: vi.fn(),
      shutdown: vi.fn(),
      runCommand: vi.fn(async (command: string) => {
        executedCommands.push(command);
        if (command.includes("test -p")) {
          return "ready";
        }
        return "";
      }),
      runBackgroundCommand: vi.fn(),
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(async (path: string, content: string) => {
        writtenFiles[path] = content;
      }),
      writeFile: vi.fn(),
    };
  });

  describe("MCP config merging", () => {
    it("should install daemon with default MCP config when no user config provided", async () => {
      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      // Check that MCP config was written
      expect(writtenFiles["/tmp/mcp-server.json"]).toBeDefined();
      const mcpConfig = JSON.parse(writtenFiles["/tmp/mcp-server.json"]!);

      expect(mcpConfig).toEqual({
        mcpServers: {
          terry: {
            command: "node",
            args: ["/tmp/terry-mcp-server.mjs"],
          },
        },
      });
    });

    it("should merge user MCP config with built-in terry server", async () => {
      const userMcpConfig = {
        mcpServers: {
          "custom-server": {
            command: "python",
            args: ["-m", "custom_mcp"],
            env: {
              API_KEY: "test-key",
            },
          },
          "another-server": {
            command: "node",
            args: ["./my-server.js"],
          },
        },
      };

      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        userMcpConfig,
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      const mcpConfig = JSON.parse(writtenFiles["/tmp/mcp-server.json"]!);

      expect(mcpConfig).toEqual({
        mcpServers: {
          terry: {
            command: "node",
            args: ["/tmp/terry-mcp-server.mjs"],
          },
          "custom-server": {
            command: "python",
            args: ["-m", "custom_mcp"],
            env: {
              API_KEY: "test-key",
            },
          },
          "another-server": {
            command: "node",
            args: ["./my-server.js"],
          },
        },
      });
    });

    it("should not allow overriding the built-in terry server", async () => {
      const userMcpConfig = {
        mcpServers: {
          terry: {
            command: "malicious-command",
            args: ["--hack"],
          },
          "legitimate-server": {
            command: "node",
            args: ["./server.js"],
          },
        },
      };

      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        userMcpConfig,
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      const mcpConfig = JSON.parse(writtenFiles["/tmp/mcp-server.json"]!);

      // Terry server should remain unchanged
      expect(mcpConfig.mcpServers.terry).toEqual({
        command: "node",
        args: ["/tmp/terry-mcp-server.mjs"],
      });

      // Other servers should be included
      expect(mcpConfig.mcpServers["legitimate-server"]).toEqual({
        command: "node",
        args: ["./server.js"],
      });
    });

    it("should handle empty user MCP config", async () => {
      const userMcpConfig = {
        mcpServers: {},
      };

      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        userMcpConfig,
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      const mcpConfig = JSON.parse(writtenFiles["/tmp/mcp-server.json"]!);

      expect(mcpConfig).toEqual({
        mcpServers: {
          terry: {
            command: "node",
            args: ["/tmp/terry-mcp-server.mjs"],
          },
        },
      });
    });

    it("should pass MCP config path to daemon", async () => {
      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      // Check that the daemon was started with the correct MCP config path
      const backgroundCommand = (mockSession.runBackgroundCommand as any).mock
        .calls[0][0];
      expect(backgroundCommand).toContain("--mcp-config-path");
      expect(backgroundCommand).toContain("/tmp/mcp-server.json");
    });
  });

  describe("environment variables", () => {
    it("should pass environment variables to daemon", async () => {
      const envVars = [
        { key: "API_KEY", value: "secret-key" },
        { key: "DATABASE_URL", value: "postgres://localhost" },
      ];

      await installDaemon({
        session: mockSession,
        environmentVariables: envVars,
        agentCredentials: null,
        githubAccessToken: "test-token",
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      const backgroundCommandOptions = (mockSession.runBackgroundCommand as any)
        .mock.calls[0][1];
      expect(backgroundCommandOptions.env).toEqual({
        BASH_MAX_TIMEOUT_MS: "60000",
        API_KEY: "secret-key",
        DATABASE_URL: "postgres://localhost",
        TERRAGON: "true",
        GH_TOKEN: "test-token",
        TERRAGON_FEATURE_FLAGS: "{}",
      });
    });

    it("should handle MCP config and environment variables together", async () => {
      const envVars = [{ key: "MCP_API_KEY", value: "mcp-secret" }];

      const userMcpConfig = {
        mcpServers: {
          "api-server": {
            command: "node",
            args: ["api.js"],
            env: {
              API_KEY: "${MCP_API_KEY}",
            },
          },
        },
      };

      await installDaemon({
        session: mockSession,
        environmentVariables: envVars,
        agentCredentials: null,
        githubAccessToken: "test-token",
        userMcpConfig,
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      // Check environment variables
      const backgroundCommandOptions = (mockSession.runBackgroundCommand as any)
        .mock.calls[0][1];
      expect(backgroundCommandOptions.env.MCP_API_KEY).toBe("mcp-secret");

      // Check MCP config
      const mcpConfig = JSON.parse(writtenFiles["/tmp/mcp-server.json"]!);
      expect(mcpConfig.mcpServers["api-server"]).toBeDefined();
    });
  });

  describe("file permissions", () => {
    it("should make daemon executable", async () => {
      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      expect(executedCommands).toContain("chmod +x /tmp/terragon-daemon.mjs");
    });

    it("should write all required files", async () => {
      await installDaemon({
        session: mockSession,
        environmentVariables: [],
        agentCredentials: null,
        githubAccessToken: "test-token",
        publicUrl: "http://localhost:3000",
        featureFlags: {},
      });

      expect(writtenFiles["/tmp/terragon-daemon.mjs"]).toBe(
        "mock-daemon-content",
      );
      expect(writtenFiles["/tmp/terry-mcp-server.mjs"]).toBe(
        "mock-mcp-server-content",
      );
      expect(writtenFiles["/tmp/mcp-server.json"]).toBeDefined();
    });
  });

  describe("daemon message transport", () => {
    it("writes payload to file and sends daemon write via stdin redirection", async () => {
      await sendMessage({
        session: mockSession,
        message: { type: "ping" },
      });

      expect(
        (mockSession.writeTextFile as any).mock.calls.length,
      ).toBeGreaterThan(0);
      const [messageFilePath, messageJson] = (mockSession.writeTextFile as any)
        .mock.calls[(mockSession.writeTextFile as any).mock.calls.length - 1];
      expect(messageFilePath).toMatch(
        /^\/tmp\/terragon-daemon-message-[0-9]+-[a-f0-9]{12}\.json$/,
      );
      expect(messageJson).toBe(JSON.stringify({ type: "ping" }));

      expect(executedCommands).toContain(
        `node /tmp/terragon-daemon.mjs --write < ${messageFilePath}`,
      );
      expect(executedCommands).toContain(`rm -f ${messageFilePath}`);
    });

    it("cleans up message file when daemon write fails", async () => {
      (mockSession.runCommand as any).mockImplementation(
        async (command: string) => {
          executedCommands.push(command);
          if (command.includes("--write <")) {
            throw new Error("fatal daemon write failure");
          }
          return "";
        },
      );

      await expect(
        sendMessage({
          session: mockSession,
          message: { type: "ping" },
        }),
      ).rejects.toThrow("fatal daemon write failure");

      const [messageFilePath] = (mockSession.writeTextFile as any).mock.calls[
        (mockSession.writeTextFile as any).mock.calls.length - 1
      ];
      expect(executedCommands).toContain(`rm -f ${messageFilePath}`);
    });
  });
});

describe("daemon restart process-leak guard", () => {
  // Only the fields consumed by restartDaemonIfNotRunning / updateDaemonIfOutdated
  // are required here; cast to CreateSandboxOptions to avoid listing every field.
  const baseOptions = {
    environmentVariables: [],
    githubAccessToken: "test-token",
    agentCredentials: null,
    publicUrl: "http://localhost:3000",
    featureFlags: {},
  } as unknown as CreateSandboxOptions;

  let mockSession: ISandboxSession;
  let executedCommands: string[];

  function makeMockSession(
    opts: {
      pingResponds?: boolean;
      killMessageFails?: boolean;
      daemonExists?: boolean;
    } = {},
  ): ISandboxSession {
    const {
      pingResponds = false,
      killMessageFails = false,
      daemonExists = true,
    } = opts;

    // Track whether background command (new daemon start) has been called.
    // After that point, simulate a live daemon so waitForDaemonReady resolves.
    let daemonStarted = false;

    const runBackgroundCommand = vi.fn(async () => {
      daemonStarted = true;
    });

    const runCommand = vi.fn(async (command: string) => {
      executedCommands.push(command);

      // After new daemon has been started, any ping attempt should succeed.
      if (daemonStarted && command.includes("--write <")) {
        return "";
      }

      // Simulate stuck/dead old daemon: --write commands fail before restart
      if (command.includes("--write <")) {
        if (killMessageFails || !pingResponds) {
          throw new Error("ENOENT: socket not found");
        }
        return "";
      }

      // test -f daemon exists check
      if (
        command.includes("test -f /tmp/terragon-daemon.mjs") ||
        command.includes(`echo "exists"`) ||
        command.includes(`echo "missing"`)
      ) {
        return daemonExists ? "exists" : "missing";
      }

      // sha256sum hash check for updateDaemonIfOutdated
      if (command.includes("sha256sum")) {
        return "differenthash";
      }

      // pkill — always exits successfully (may return 1 if no processes found,
      // but we never throw)
      if (command.startsWith("pkill")) {
        return "";
      }

      // rm -f for file cleanup
      if (command.startsWith("rm -f")) {
        return "";
      }

      return "";
    });

    return {
      sandboxId: "test-sandbox-id",
      sandboxProvider: "docker",
      repoDir: "repo",
      homeDir: "root",
      hibernate: vi.fn(),
      shutdown: vi.fn(),
      runCommand,
      runBackgroundCommand,
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(async (_path: string, _content: string) => {}),
      writeFile: vi.fn(),
    };
  }

  beforeEach(() => {
    executedCommands = [];
    vi.mock("@terragon/bundled", () => ({
      daemonAsStr: "mock-daemon-content",
      mcpServerAsStr: "mock-mcp-server-content",
    }));
  });

  describe("restartDaemonIfNotRunning", () => {
    it("force-kills existing daemon processes via pkill before starting a new one when graceful kill fails", async () => {
      mockSession = makeMockSession({
        pingResponds: false,
        killMessageFails: true,
        daemonExists: true,
      });

      await restartDaemonIfNotRunning({
        session: mockSession,
        options: baseOptions,
      });

      const pkillCmd = executedCommands.find((c) => c.startsWith("pkill"));
      expect(
        pkillCmd,
        "pkill -f terragon-daemon.mjs must run when graceful kill fails to prevent process accumulation",
      ).toBeDefined();
      expect(pkillCmd).toContain("terragon-daemon.mjs");

      // New daemon must have been started after force-kill
      expect(mockSession.runBackgroundCommand).toHaveBeenCalled();
    });

    it("force-kills existing daemon processes via pkill even when graceful kill succeeds", async () => {
      mockSession = makeMockSession({
        pingResponds: false,
        killMessageFails: false,
        daemonExists: true,
      });

      await restartDaemonIfNotRunning({
        session: mockSession,
        options: baseOptions,
      });

      const pkillCmd = executedCommands.find((c) => c.startsWith("pkill"));
      expect(
        pkillCmd,
        "pkill must run to guard against any remaining daemon instances",
      ).toBeDefined();
      expect(pkillCmd).toContain("terragon-daemon.mjs");
    });

    it("does not start a new daemon if the existing one is alive (ping succeeds)", async () => {
      // Daemon responds to pings — restartDaemonIfNotRunning should return early
      mockSession = makeMockSession({ pingResponds: true });

      await restartDaemonIfNotRunning({
        session: mockSession,
        options: baseOptions,
      });

      // Daemon is alive → no background command
      expect(mockSession.runBackgroundCommand).not.toHaveBeenCalled();
    });
  });

  describe("updateDaemonIfOutdated", () => {
    it("force-kills via pkill before installing the updated daemon when graceful kill fails", async () => {
      mockSession = makeMockSession({
        pingResponds: false,
        killMessageFails: true,
        daemonExists: true,
      });

      await updateDaemonIfOutdated({
        session: mockSession,
        options: baseOptions,
      });

      const pkillCmd = executedCommands.find((c) => c.startsWith("pkill"));
      expect(
        pkillCmd,
        "pkill must be called to prevent stale daemon accumulation during updates",
      ).toBeDefined();
      expect(pkillCmd).toContain("terragon-daemon.mjs");
    });
  });
});
