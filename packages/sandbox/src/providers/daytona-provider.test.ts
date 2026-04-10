import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSandboxOptions } from "../types";

const daytonaCreateMock = vi.fn();
const daytonaGetMock = vi.fn();

vi.mock("@daytonaio/sdk", () => {
  class MockDaytona {
    constructor(_options: { apiKey: string }) {}

    create = daytonaCreateMock;
    get = daytonaGetMock;
  }

  return {
    Daytona: MockDaytona,
    Sandbox: class {},
  };
});

vi.mock("@terragon/sandbox-image", () => ({
  getTemplateIdForSize: vi.fn(() => "unused-template"),
}));

import { DaytonaProvider } from "./daytona-provider";

type MockDaytonaSandbox = {
  id: string;
  state: string;
  autoStopInterval: number;
  autoArchiveInterval: number;
  autoDeleteInterval: number;
  archive: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  fs: {
    downloadFile: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
  };
  process: {
    createSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
    executeCommand: ReturnType<typeof vi.fn>;
    executeSessionCommand: ReturnType<typeof vi.fn>;
    getSessionCommand: ReturnType<typeof vi.fn>;
    getSessionCommandLogs: ReturnType<typeof vi.fn>;
  };
  refreshData: ReturnType<typeof vi.fn>;
  setAutoArchiveInterval: ReturnType<typeof vi.fn>;
  setAutoDeleteInterval: ReturnType<typeof vi.fn>;
  setAutostopInterval: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  waitUntilStarted: ReturnType<typeof vi.fn>;
  waitUntilStopped: ReturnType<typeof vi.fn>;
};

const defaultOptions: CreateSandboxOptions = {
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

function createMockSandbox(
  overrides: Partial<MockDaytonaSandbox> = {},
): MockDaytonaSandbox {
  return {
    id: "sandbox-123",
    state: "stopped",
    autoStopInterval: 15,
    autoArchiveInterval: 360,
    autoDeleteInterval: 60 * 24 * 30,
    archive: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    fs: {
      downloadFile: vi.fn(),
      uploadFile: vi.fn().mockResolvedValue(undefined),
    },
    process: {
      createSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: "" }),
      executeSessionCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        cmdId: "cmd-123",
      }),
      getSessionCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
      getSessionCommandLogs: vi.fn().mockResolvedValue(undefined),
    },
    refreshData: vi.fn().mockResolvedValue(undefined),
    setAutoArchiveInterval: vi.fn().mockResolvedValue(undefined),
    setAutoDeleteInterval: vi.fn().mockResolvedValue(undefined),
    setAutostopInterval: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    waitUntilStarted: vi.fn().mockResolvedValue(undefined),
    waitUntilStopped: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("DaytonaProvider lifecycle policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DAYTONA_API_KEY", "test-api-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates new sandboxes with the intended lifecycle policy", async () => {
    const sandbox = createMockSandbox();
    daytonaCreateMock.mockResolvedValue(sandbox);

    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(null, {
      ...defaultOptions,
      snapshotTemplateId: "snapshot-template",
    });

    expect(daytonaCreateMock).toHaveBeenCalledWith({
      user: "root",
      snapshot: "snapshot-template",
      envVars: {},
      autoStopInterval: 15,
      autoArchiveInterval: 360,
      autoDeleteInterval: 60 * 24 * 30,
    });
  });

  it("reconciles stale lifecycle settings when resuming an existing sandbox", async () => {
    const sandbox = createMockSandbox({
      autoStopInterval: 5,
      autoArchiveInterval: 5,
    });
    daytonaGetMock.mockResolvedValue(sandbox);

    const provider = new DaytonaProvider();
    const session = await provider.getOrCreateSandbox(
      "sandbox-123",
      defaultOptions,
    );

    expect(session.sandboxId).toBe("sandbox-123");
    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(15);
    expect(sandbox.setAutoArchiveInterval).toHaveBeenCalledWith(360);
    expect(sandbox.setAutoDeleteInterval).not.toHaveBeenCalled();
  });

  it("skips lifecycle updates when the resumed sandbox already matches policy", async () => {
    const sandbox = createMockSandbox();
    daytonaGetMock.mockResolvedValue(sandbox);

    const provider = new DaytonaProvider();
    const session = await provider.getSandboxOrNull("sandbox-123");

    expect(session?.sandboxId).toBe("sandbox-123");
    expect(sandbox.setAutostopInterval).not.toHaveBeenCalled();
    expect(sandbox.setAutoArchiveInterval).not.toHaveBeenCalled();
  });

  it("extends life through SDK activity instead of shelling into the sandbox", async () => {
    const sandbox = createMockSandbox();
    daytonaGetMock.mockResolvedValue(sandbox);

    const provider = new DaytonaProvider();
    await provider.extendLife("sandbox-123");

    expect(daytonaGetMock).toHaveBeenCalledWith("sandbox-123");
    expect(sandbox.refreshData).toHaveBeenCalledTimes(1);
    expect(sandbox.start).not.toHaveBeenCalled();
    expect(sandbox.process.executeCommand).not.toHaveBeenCalled();
  });

  it("keeps resume non-blocking when lifecycle reconciliation fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sandbox = createMockSandbox({
      autoStopInterval: 5,
      setAutostopInterval: vi.fn().mockRejectedValue(new Error("bad policy")),
    });
    daytonaGetMock.mockResolvedValue(sandbox);

    const provider = new DaytonaProvider();
    const session = await provider.getSandboxOrNull("sandbox-123");

    expect(session?.sandboxId).toBe("sandbox-123");
    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(15);
    expect(sandbox.setAutoArchiveInterval).not.toHaveBeenCalled();
    expect(sandbox.setAutoDeleteInterval).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "Failed to reconcile auto-stop lifecycle policy for sandbox sandbox-123",
    );
    expect(warnSpy.mock.calls[0]?.[0]).toContain("bad policy");
    warnSpy.mockRestore();
  });

  it("retries keepalive without starting a stopped sandbox", async () => {
    const sandbox = createMockSandbox({
      state: "stopped",
      refreshData: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient keepalive failure"))
        .mockResolvedValue(undefined),
    });
    daytonaGetMock.mockResolvedValue(sandbox);

    const provider = new DaytonaProvider();
    await provider.extendLife("sandbox-123");

    expect(daytonaGetMock).toHaveBeenCalledTimes(2);
    expect(sandbox.refreshData).toHaveBeenCalledTimes(2);
    expect(sandbox.start).not.toHaveBeenCalled();
  });
});
