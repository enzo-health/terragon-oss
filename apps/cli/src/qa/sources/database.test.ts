import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DatabaseSourceFetcher,
  createDatabaseFetcher,
  sanitizeUuid,
} from "./database.js";
import { Client } from "pg";

// Mock pg Client
vi.mock("pg", () => ({
  Client: vi.fn(),
}));

describe("sanitizeUuid", () => {
  it("should return valid UUID unchanged", () => {
    const validUuid = "7d4ea142-0a2e-4837-bee3-a5603163e106";
    expect(sanitizeUuid(validUuid)).toBe(validUuid);
  });

  it("should throw for invalid characters", () => {
    const invalidUuid = "7d4ea142-0a2e-4837-bee3-a5603163e106; DROP TABLE";
    expect(() => sanitizeUuid(invalidUuid)).toThrow("Invalid UUID format");
  });

  it("should throw for wrong length", () => {
    const shortUuid = "7d4ea142-0a2e-4837-bee3";
    expect(() => sanitizeUuid(shortUuid)).toThrow("Invalid UUID format");
  });

  it("should throw for empty string", () => {
    expect(() => sanitizeUuid("")).toThrow("Invalid UUID format");
  });
});

describe("createDatabaseFetcher", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should create fetcher with provided connection string", () => {
    const fetcher = createDatabaseFetcher("postgresql://test/test");
    expect(fetcher).toBeInstanceOf(DatabaseSourceFetcher);
  });

  it("should create fetcher with DATABASE_URL env var", () => {
    process.env.DATABASE_URL = "postgresql://env/test";
    const fetcher = createDatabaseFetcher();
    expect(fetcher).toBeInstanceOf(DatabaseSourceFetcher);
  });

  it("should throw if no connection string provided", () => {
    expect(() => createDatabaseFetcher()).toThrow("DATABASE_URL");
  });
});

describe("DatabaseSourceFetcher", () => {
  let fetcher: DatabaseSourceFetcher;
  let mockClient: any;

  beforeEach(() => {
    fetcher = new DatabaseSourceFetcher({
      connectionString: "postgresql://test/test",
      timeoutMs: 5000,
    });

    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(Client).mockImplementation(() => mockClient);
  });

  describe("fetchWorkflowState", () => {
    it("should return workflow data on success", async () => {
      const mockWorkflow = {
        workflowId: "wf-123",
        threadId: "thread-456",
        state: "implementing",
        activeGate: null,
        headSha: "abc123",
        activeRunId: "run-789",
        version: 5,
        generation: 1,
        fixAttemptCount: 0,
        infraRetryCount: 0,
        blockedReason: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-02",
        lastActivityAt: "2024-01-02",
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockWorkflow] });

      const result = await fetcher.fetchWorkflowState(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result.name).toBe("database");
      expect(result.data).toEqual(mockWorkflow);
      expect(result.error).toBeUndefined();
    });

    it("should throw if workflow not found", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        fetcher.fetchWorkflowState("7d4ea142-0a2e-4837-bee3-a5603163e106"),
      ).rejects.toThrow("No workflow found");
    });

    it("should sanitize invalid thread ID", async () => {
      await expect(
        fetcher.fetchWorkflowState("invalid; DROP TABLE"),
      ).rejects.toThrow("Invalid UUID format");
    });
  });

  describe("fetchThreadState", () => {
    it("should return thread data on success", async () => {
      const mockThread = {
        id: "thread-456",
        status: "queued",
        name: "Test Task",
        currentBranchName: "feature/test",
        repoBaseBranchName: "main",
        githubPrNumber: 123,
        githubRepoFullName: "owner/repo",
        sandboxProvider: "docker",
        codesandboxId: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-02",
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockThread] });

      const result = await fetcher.fetchThreadState(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result.name).toBe("database");
      expect(result.data).toEqual(mockThread);
    });

    it("should throw if thread not found", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        fetcher.fetchThreadState("7d4ea142-0a2e-4837-bee3-a5603163e106"),
      ).rejects.toThrow("No thread found");
    });
  });

  describe("fetchAll", () => {
    it("should fetch workflow and thread", async () => {
      const mockWorkflow = {
        workflowId: "wf-123",
        threadId: "thread-456",
        state: "implementing",
        activeGate: null,
        headSha: "abc123",
        activeRunId: "run-789",
        version: 5,
        generation: 1,
        fixAttemptCount: 0,
        infraRetryCount: 0,
        blockedReason: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-02",
        lastActivityAt: "2024-01-02",
      };

      const mockThread = {
        id: "thread-456",
        status: "queued",
        name: "Test Task",
        currentBranchName: "feature/test",
        repoBaseBranchName: "main",
        githubPrNumber: null,
        githubRepoFullName: "owner/repo",
        sandboxProvider: "docker",
        codesandboxId: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-02",
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [mockWorkflow] }) // workflow
        .mockResolvedValueOnce({ rows: [mockThread] }) // thread
        .mockResolvedValueOnce({ rows: [] }) // events
        .mockResolvedValueOnce({ rows: [{ maxVersion: 5 }] }); // version

      const result = await fetcher.fetchAll(
        "7d4ea142-0a2e-4837-bee3-a5603163e106",
      );

      expect(result.workflow.data).toEqual(mockWorkflow);
      expect(result.thread.data).toEqual(mockThread);
    });
  });
});
