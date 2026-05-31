import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "./types";

const mocks = vi.hoisted(() => ({
  getOrCreateSandbox: vi.fn<ISandboxProvider["getOrCreateSandbox"]>(),
  shutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock("./provider", () => ({
  getSandboxProvider: vi.fn(
    (): ISandboxProvider => ({
      getOrCreateSandbox: mocks.getOrCreateSandbox,
      getSandboxOrNull: vi.fn(),
      hibernateById: vi.fn(),
      extendLife: vi.fn(),
    }),
  ),
}));

vi.mock("./setup", () => ({
  setupSandboxEveryTime: vi.fn(),
  setupSandboxOneTime: vi.fn(),
}));

import { getOrCreateSandbox } from "./sandbox";

class TestSession implements ISandboxSession {
  public readonly sandboxProvider = "mock";
  public readonly homeDir = "root";
  public readonly repoDir = "repo";

  constructor(public readonly sandboxId: string) {}

  async hibernate(): Promise<void> {}

  async shutdown(): Promise<void> {
    await mocks.shutdown();
  }

  async runCommand(): Promise<string> {
    return "";
  }

  async runBackgroundCommand(
    _command: string,
    _options?: BackgroundCommandOptions,
  ): Promise<void> {}

  async readTextFile(): Promise<string> {
    return "";
  }

  async writeTextFile(): Promise<void> {}

  async writeFile(): Promise<void> {}
}

function buildOptions(
  overrides: Partial<CreateSandboxOptions> = {},
): CreateSandboxOptions {
  return {
    threadName: "test-thread",
    agent: null,
    agentCredentials: null,
    userName: "Test User",
    userEmail: "test@example.com",
    githubAccessToken: "token",
    githubRepoFullName: "owner/repo",
    repoBaseBranchName: "main",
    userId: "user-123",
    sandboxProvider: "mock",
    sandboxSize: "small",
    createNewBranch: true,
    environmentVariables: [],
    autoUpdateDaemon: false,
    publicUrl: "http://localhost:3000",
    featureFlags: {},
    generateBranchName: async () => null,
    onStatusUpdate: async () => {},
    ...overrides,
  };
}

describe("sandbox allocation persistence", () => {
  beforeEach(() => {
    mocks.getOrCreateSandbox.mockReset();
    mocks.shutdown.mockReset();
  });

  it("cleans up a fresh sandbox when allocated sandbox persistence fails", async () => {
    const allocationError = new Error("database unavailable");
    mocks.getOrCreateSandbox.mockResolvedValue(new TestSession("sandbox-123"));

    await expect(
      getOrCreateSandbox(
        null,
        buildOptions({
          onSandboxAllocated: async () => {
            throw allocationError;
          },
        }),
      ),
    ).rejects.toBe(allocationError);

    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not shut down a resumed sandbox when allocated sandbox persistence fails", async () => {
    const allocationError = new Error("database unavailable");
    mocks.getOrCreateSandbox.mockResolvedValue(new TestSession("sandbox-123"));

    await expect(
      getOrCreateSandbox(
        "sandbox-123",
        buildOptions({
          onSandboxAllocated: async () => {
            throw allocationError;
          },
        }),
      ),
    ).rejects.toBe(allocationError);

    expect(mocks.shutdown).not.toHaveBeenCalled();
  });
});
