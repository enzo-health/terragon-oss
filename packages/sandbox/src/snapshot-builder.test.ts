import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshotCreateMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("@daytonaio/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@daytonaio/sdk")>("@daytonaio/sdk");

  class MockDaytona {
    constructor(_options: { apiKey: string }) {}

    snapshot = {
      create: snapshotCreateMock,
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
  }

  return {
    ...actual,
    Daytona: MockDaytona,
  };
});

import {
  buildRepoSnapshot,
  getUnsafeRepoSnapshotInputReasons,
  isRepoSnapshotBuildSafe,
} from "./snapshot-builder";

describe("snapshot-builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DAYTONA_API_KEY", "daytona-key");
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "clone") {
        const repoPath = args.at(-1);
        if (typeof repoPath !== "string") {
          throw new Error("missing repo path");
        }
        fs.mkdirSync(repoPath, { recursive: true });
        fs.writeFileSync(path.join(repoPath, "package.json"), "{}");
        fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
        fs.writeFileSync(
          path.join(repoPath, ".git", "config"),
          '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n',
        );
      }
      return Buffer.from("");
    });
    snapshotCreateMock.mockImplementation(async (_params, options) => {
      options?.onLogs?.(
        "creating with ghp_secret_token and secret-env-value in logs",
      );
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("classifies decrypted snapshot inputs as unsafe", () => {
    expect(
      getUnsafeRepoSnapshotInputReasons({
        setupScript: "echo setup",
        environmentVariables: [{ key: "SECRET", value: "secret-env-value" }],
        mcpConfig: { mcpServers: { linear: { token: "mcp-token" } } },
      }),
    ).toEqual(["setup-script", "environment-variables", "mcp-config"]);

    expect(
      isRepoSnapshotBuildSafe({
        setupScript: null,
        environmentVariables: [],
        mcpConfig: {},
      }),
    ).toBe(true);
  });

  it("fails closed before cloning when snapshot inputs would persist secrets", async () => {
    await expect(
      buildRepoSnapshot({
        repoFullName: "owner/repo",
        baseBranch: "main",
        githubAccessToken: "ghp_secret_token",
        setupScript: "echo setup",
        environmentVariables: [{ key: "SECRET", value: "secret-env-value" }],
        mcpConfig: null,
        size: "small",
      }),
    ).rejects.toThrow(
      "Repo snapshot build disabled for unsafe inputs: setup-script, environment-variables",
    );

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(snapshotCreateMock).not.toHaveBeenCalled();
  });

  it("builds from a sanitized local clone without persisted tokens or env values", async () => {
    const logs: string[] = [];

    await buildRepoSnapshot({
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "ghp_secret_token",
      setupScript: null,
      environmentVariables: [],
      mcpConfig: null,
      size: "small",
      onLogs: (chunk) => logs.push(chunk),
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "clone",
        "--filter=blob:none",
        "--branch",
        "main",
        "https://github.com/owner/repo.git",
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
          GITHUB_ACCESS_TOKEN: "ghp_secret_token",
        }),
      }),
    );

    const createArgs = snapshotCreateMock.mock.calls[0]?.[0];
    expect(createArgs).toBeDefined();
    const dockerfile = String(createArgs.image.dockerfile);
    expect(dockerfile).not.toContain("ghp_secret_token");
    expect(dockerfile).not.toContain("secret-env-value");
    expect(dockerfile).not.toContain("GITHUB_ACCESS_TOKEN");
    expect(dockerfile).not.toContain("git clone");
    expect(dockerfile).not.toContain("terragon-setup.sh");
    expect(dockerfile).toContain("COPY ");
    expect(dockerfile).toContain("/root/repo");
    expect(dockerfile).toContain("rm -rf /root/repo/.next");
    expect(dockerfile).toContain(
      "git -C /root/repo remote set-url origin https://github.com/owner/repo.git",
    );
    expect(logs).toEqual([
      "creating with [REDACTED] and secret-env-value in logs",
    ]);
  });
});
