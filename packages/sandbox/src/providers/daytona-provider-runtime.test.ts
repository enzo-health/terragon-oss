import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSandboxOptions } from "../types";

const daytonaCreateMock = vi.fn();
const daytonaConstructorOptionsMock = vi.fn();
type RuntimeRequireMock = ReturnType<typeof vi.fn> & {
  resolve: ReturnType<typeof vi.fn>;
};
const runtimeRequireMock: RuntimeRequireMock = Object.assign(vi.fn(), {
  resolve: vi.fn(),
});
const createRequireMock = vi.fn(() => runtimeRequireMock);

vi.mock("node:module", () => ({
  createRequire: createRequireMock,
}));

vi.mock("@daytonaio/sdk", () => {
  class MockDaytona {
    constructor(options: { apiKey: string }) {
      daytonaConstructorOptionsMock(options);
    }

    create = daytonaCreateMock;
    get = vi.fn();
    volume = {
      get: vi.fn(),
      list: vi.fn(),
    };
  }

  return {
    Daytona: MockDaytona,
    Sandbox: class {},
  };
});

vi.mock("@terragon/sandbox-image", () => ({
  getTemplateIdForSize: vi.fn(() => "unused-template"),
}));

function createOptions(): CreateSandboxOptions {
  return {
    threadName: "test-title",
    userName: "test-user",
    userEmail: "test@example.com",
    githubAccessToken: "test-token",
    githubRepoFullName: "owner/repo",
    repoBaseBranchName: "main",
    userId: "user-123",
    sandboxProvider: "daytona",
    sandboxSize: "small",
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
}

describe("DaytonaProvider bundled runtime module resolution", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("skips filesystem SDK dependency probing when require.resolve returns a bundled module id", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "test-api-key");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    runtimeRequireMock.resolve.mockReturnValue(889967);
    daytonaCreateMock.mockResolvedValue({
      id: "sandbox-123",
      state: "started",
      autoStopInterval: 15,
      autoArchiveInterval: 360,
      autoDeleteInterval: 60 * 24 * 30,
      setAutoArchiveInterval: vi.fn(),
      setAutostopInterval: vi.fn(),
      process: {
        executeCommand: vi.fn().mockResolvedValue({
          exitCode: 0,
          result: "",
        }),
      },
    });

    try {
      const { DaytonaProvider } = await import("./daytona-provider");
      const provider = new DaytonaProvider();
      const session = await provider.getOrCreateSandbox(null, {
        ...createOptions(),
        snapshotTemplateId: "snapshot-template",
      });

      expect(session.sandboxId).toBe("sandbox-123");
      expect(daytonaConstructorOptionsMock).toHaveBeenCalledWith({
        apiKey: "test-api-key",
      });
      expect(daytonaCreateMock).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        "[daytona] @daytonaio/sdk resolved to a non-path module id",
        {
          type: "number",
          value: 889967,
        },
      );
    } finally {
      debugSpy.mockRestore();
    }
  });
});
