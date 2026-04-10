import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ContainerSourceFetcher,
  createContainerFetcher,
  sanitizeContainerId,
  sanitizeThreadId,
} from "./container.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockedExecFile = vi.mocked(execFile);

describe("sanitizeContainerId", () => {
  it("should return valid container ID unchanged", () => {
    const validId = "abc123def456";
    expect(sanitizeContainerId(validId)).toBe(validId);
  });

  it("should throw for invalid characters", () => {
    const invalidId = "abc123; rm -rf /";
    expect(() => sanitizeContainerId(invalidId)).toThrow(
      "Invalid container ID",
    );
  });

  it("should throw for shell metacharacters", () => {
    const dangerousId = "container`whoami`";
    expect(() => sanitizeContainerId(dangerousId)).toThrow(
      "Invalid container ID",
    );
  });
});

describe("sanitizeThreadId", () => {
  it("should return valid thread ID unchanged", () => {
    const validId = "7d4ea142-0a2e-4837-bee3-a5603163e106";
    expect(sanitizeThreadId(validId)).toBe(validId);
  });

  it("should throw for invalid characters", () => {
    const invalidId = "7d4ea142; DROP TABLE";
    expect(() => sanitizeThreadId(invalidId)).toThrow("Invalid thread ID");
  });
});

describe("createContainerFetcher", () => {
  it("should create fetcher with default config", () => {
    const fetcher = createContainerFetcher();
    expect(fetcher).toBeInstanceOf(ContainerSourceFetcher);
  });
});

describe("ContainerSourceFetcher", () => {
  let fetcher: ContainerSourceFetcher;

  beforeEach(() => {
    fetcher = new ContainerSourceFetcher({ timeoutMs: 5000 });
    vi.clearAllMocks();
  });

  describe("fetchDockerContainer", () => {
    it("should return container data on success", async () => {
      const containerState = JSON.stringify({ Status: "running" });

      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (args && args[0] === "inspect") {
            cb(null, { stdout: containerState, stderr: "" });
          } else if (args && args[0] === "exec" && args[2] === "pgrep") {
            cb(null, { stdout: "1234\n", stderr: "" });
          } else if (args && args[0] === "logs") {
            cb(null, {
              stdout: "2024-01-01T12:00:00.123456789Z log\n",
              stderr: "",
            });
          } else if (args && args[2] === "git") {
            if (args[4] === "--abbrev-ref") {
              cb(null, { stdout: "feature/test\n", stderr: "" });
            } else if (args[4] === "HEAD") {
              cb(null, { stdout: "abc123def456789\n", stderr: "" });
            } else {
              cb(null, { stdout: "", stderr: "" });
            }
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.fetchDockerContainer("container123");

      expect(result.name).toBe("container");
      expect(result.data.status).toBe("running");
      expect(result.data.daemonRunning).toBe(true);
      expect(result.data.daemonPid).toBe(1234);
      expect(result.data.gitStatus).toEqual({
        branch: "feature/test",
        headSha: "abc123def456789",
        hasUncommittedChanges: false,
      });
    });

    it("should handle container not found", async () => {
      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          cb(new Error("No such container"), {
            stdout: "",
            stderr: "No such container",
          });
          return undefined as any;
        },
      );

      const result = await fetcher.fetchDockerContainer("nonexistent");

      expect(result.name).toBe("container");
      expect(result.data.status).toBe("unknown");
      expect(result.data.daemonRunning).toBe(false);
      expect(result.error).toContain("No such container");
    });

    it("should handle paused container", async () => {
      const containerState = JSON.stringify({ Status: "paused" });

      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (args && args[0] === "inspect") {
            cb(null, { stdout: containerState, stderr: "" });
          } else {
            cb(new Error("daemon not running"), { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.fetchDockerContainer("container123");

      expect(result.data.status).toBe("paused");
      expect(result.data.daemonRunning).toBe(false);
    });

    it("should sanitize invalid container ID", async () => {
      await expect(
        fetcher.fetchDockerContainer("container; rm -rf /"),
      ).rejects.toThrow("Invalid container ID");
    });
  });

  describe("findContainerForThread", () => {
    it("should find container by label", async () => {
      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (
            args &&
            Array.isArray(args) &&
            args.some(
              (arg) =>
                typeof arg === "string" && arg.startsWith("label=threadId="),
            )
          ) {
            cb(null, { stdout: "abc123\n", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.findContainerForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result).toBe("abc123");
    });

    it("should find container by name fallback", async () => {
      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (
            args &&
            Array.isArray(args) &&
            args.some(
              (arg) =>
                typeof arg === "string" && arg.startsWith("label=threadId="),
            )
          ) {
            cb(null, { stdout: "", stderr: "" });
          } else if (args && args[0] === "ps" && args[1] === "-a") {
            cb(null, {
              stdout: "abc123 container-63e106 running\n",
              stderr: "",
            });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.findContainerForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result).toBe("abc123");
    });

    it("should find container by full thread ID in labels fallback", async () => {
      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (
            args &&
            Array.isArray(args) &&
            args.some(
              (arg) =>
                typeof arg === "string" && arg.startsWith("label=threadId="),
            )
          ) {
            cb(null, { stdout: "", stderr: "" });
          } else if (args && args[0] === "ps" && args[1] === "-a") {
            cb(null, {
              stdout:
                "abc123 sandbox-qa com.docker.compose.project=leo,threadId=7d4ea142-0a2e-4837-bee3-a5603163e106\n",
              stderr: "",
            });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.findContainerForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result).toBe("abc123");
    });

    it("should return null if no container found", async () => {
      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          cb(null, { stdout: "", stderr: "" });
          return undefined as any;
        },
      );

      const result = await fetcher.findContainerForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result).toBeNull();
    });

    it("should sanitize invalid thread ID", async () => {
      const result = await fetcher.findContainerForThread(
        "invalid; DROP TABLE",
      );
      expect(result).toBeNull();
    });
  });

  describe("fetchForThread", () => {
    it("should return error if no container found", async () => {
      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          cb(null, { stdout: "", stderr: "" });
          return undefined as any;
        },
      );

      const result = await fetcher.fetchForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result.name).toBe("container");
      expect(result.data.status).toBe("unknown");
      expect(result.error).toContain("No container found");
    });

    it("should fetch container when found", async () => {
      const containerState = JSON.stringify({ Status: "running" });

      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (
            args &&
            Array.isArray(args) &&
            args.some(
              (arg) =>
                typeof arg === "string" && arg.startsWith("label=threadId="),
            )
          ) {
            cb(null, { stdout: "abc123\n", stderr: "" });
          } else if (args && args[0] === "inspect") {
            cb(null, { stdout: containerState, stderr: "" });
          } else if (args && args[0] === "exec" && args[2] === "pgrep") {
            cb(null, { stdout: "1234\n", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.fetchForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result.data.sandboxId).toBe("abc123");
      expect(result.data.status).toBe("running");
    });

    it("should prefer explicit sandboxId when provided", async () => {
      const containerState = JSON.stringify({ Status: "running" });

      mockedExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, cb: any) => {
          if (args && args[0] === "inspect" && args[1] === "sandbox-123") {
            cb(null, { stdout: containerState, stderr: "" });
          } else if (args && args[0] === "exec" && args[2] === "pgrep") {
            cb(null, { stdout: "1234\n", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return undefined as any;
        },
      );

      const result = await fetcher.fetchForThread(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
        "sandbox-123",
      );

      expect(result.data.sandboxId).toBe("sandbox-123");
      expect(result.error).toBeUndefined();
    });
  });
});
