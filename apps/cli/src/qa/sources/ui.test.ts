import { describe, it, expect, vi, beforeEach } from "vitest";
import { UISourceFetcher, createUIFetcher } from "./ui.js";

// Mock dependencies
vi.mock("@orpc/client", () => ({
  createORPCClient: vi.fn(),
}));

vi.mock("@orpc/client/fetch", () => ({
  RPCLink: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("createUIFetcher", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TERRAGON_WEB_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should create fetcher with provided URL", async () => {
    const fetcher = await createUIFetcher(
      "https://test.example.com",
      "test-key",
    );
    expect(fetcher).toBeInstanceOf(UISourceFetcher);
  });

  it("should use TERRAGON_WEB_URL env var", async () => {
    process.env.TERRAGON_WEB_URL = "https://env.example.com";
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ apiKey: "test" }));

    const fetcher = await createUIFetcher();
    expect(fetcher).toBeInstanceOf(UISourceFetcher);
  });

  it("should default to localhost", async () => {
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ apiKey: "test" }));

    const fetcher = await createUIFetcher();
    expect(fetcher).toBeInstanceOf(UISourceFetcher);
  });
});

describe("UISourceFetcher", () => {
  let fetcher: UISourceFetcher;
  let mockClient: any;

  beforeEach(async () => {
    fetcher = new UISourceFetcher({
      webUrl: "http://localhost:3000",
      apiKey: "test-key",
      timeoutMs: 5000,
    });

    mockClient = {
      threads: {
        detail: vi.fn(),
        deliveryLoopStatus: vi.fn(),
      },
    };

    const { createORPCClient } = await import("@orpc/client");
    vi.mocked(createORPCClient).mockReturnValue(mockClient);
  });

  describe("fetchThreadDetail", () => {
    it("should return thread data on success", async () => {
      const mockThread = {
        id: "thread-456",
        name: "Test Thread",
        status: "queued",
      };

      mockClient.threads.detail.mockResolvedValueOnce(mockThread);

      const result = await fetcher.fetchThreadDetail("thread-456");

      expect(result.name).toBe("ui");
      expect(result.data).toEqual(mockThread);
      expect(result.error).toBeUndefined();
    });

    it("should return error on failure", async () => {
      mockClient.threads.detail.mockRejectedValueOnce(
        new Error("Thread not found"),
      );

      const result = await fetcher.fetchThreadDetail("thread-456");

      expect(result.name).toBe("ui");
      expect(result.data).toBeNull();
      expect(result.error).toBe("Thread not found");
    });
  });

  describe("fetchDeliveryLoopStatus", () => {
    it("should fetch delivery loop status successfully", async () => {
      const mockStatus = {
        loopId: "loop-123",
        state: "implementing",
        planApprovalPolicy: "auto" as const,
        stateLabel: "Implementing",
        explanation: "Agent is implementing fixes.",
        progressPercent: 25,
        actions: {
          canResume: false,
          canBypassOnce: false,
          canApprovePlan: false,
        },
        phases: [
          { key: "planning" as const, label: "Planning", status: "passed" },
          {
            key: "implementing" as const,
            label: "Implementing",
            status: "pending",
          },
          {
            key: "reviewing" as const,
            label: "Reviewing",
            status: "not_started",
          },
          { key: "ci" as const, label: "CI", status: "not_started" },
          {
            key: "ui_testing" as const,
            label: "UI Testing",
            status: "not_started",
          },
        ],
        checks: [
          {
            key: "ci",
            label: "CI",
            status: "not_started",
            detail: "Awaiting CI evaluation.",
          },
        ],
        needsAttention: {
          isBlocked: false,
          blockerCount: 0,
          topBlockers: [],
        },
        links: {
          pullRequestUrl: null,
          statusCommentUrl: null,
          checkRunUrl: null,
        },
        artifacts: {
          planningArtifact: null,
          implementationArtifact: null,
          plannedTaskSummary: {
            total: 0,
            done: 0,
            remaining: 0,
          },
          plannedTasks: [],
        },
        updatedAtIso: "2024-01-01T00:00:00.000Z",
      };

      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(mockStatus);

      const result = await fetcher.fetchDeliveryLoopStatus("thread-456");

      expect(result.name).toBe("ui");
      expect(result.data).toEqual(mockStatus);
      expect(result.error).toBeUndefined();
    });

    it("should return error when fetch fails", async () => {
      mockClient.threads.deliveryLoopStatus.mockRejectedValueOnce(
        new Error("Unauthorized"),
      );

      const result = await fetcher.fetchDeliveryLoopStatus("thread-456");

      expect(result.name).toBe("ui");
      expect(result.data).toBeNull();
      expect(result.error).toBe("Unauthorized");
    });

    it("should include state field in successful response", async () => {
      // VAL-UI-007: Asserts that response includes comparator-required state field
      const mockStatus = {
        loopId: "loop-123",
        state: "planning",
        planApprovalPolicy: "human_required" as const,
        stateLabel: "Planning",
        explanation: "Agent is drafting a plan.",
        progressPercent: 10,
        actions: {
          canResume: false,
          canBypassOnce: false,
          canApprovePlan: true,
        },
        phases: [
          { key: "planning" as const, label: "Planning", status: "pending" },
          {
            key: "implementing" as const,
            label: "Implementing",
            status: "not_started",
          },
          {
            key: "reviewing" as const,
            label: "Reviewing",
            status: "not_started",
          },
          { key: "ci" as const, label: "CI", status: "not_started" },
          {
            key: "ui_testing" as const,
            label: "UI Testing",
            status: "not_started",
          },
        ],
        checks: [],
        needsAttention: {
          isBlocked: false,
          blockerCount: 0,
          topBlockers: [],
        },
        links: {
          pullRequestUrl: null,
          statusCommentUrl: null,
          checkRunUrl: null,
        },
        artifacts: {
          planningArtifact: null,
          implementationArtifact: null,
          plannedTaskSummary: { total: 0, done: 0, remaining: 0 },
          plannedTasks: [],
        },
        updatedAtIso: "2024-01-01T00:00:00.000Z",
      };

      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(mockStatus);

      const result = await fetcher.fetchDeliveryLoopStatus("thread-123");

      expect(result.data).toBeDefined();
      expect(result.data!.state).toBe("planning");
    });

    it("should include checks array in successful response", async () => {
      // VAL-UI-007: Asserts that response includes comparator-required checks field
      const mockStatus = {
        loopId: "loop-123",
        state: "ci_gate",
        planApprovalPolicy: "auto" as const,
        stateLabel: "CI Gate",
        explanation: "Running CI checks.",
        progressPercent: 55,
        actions: {
          canResume: false,
          canBypassOnce: false,
          canApprovePlan: false,
        },
        phases: [
          { key: "planning" as const, label: "Planning", status: "passed" },
          {
            key: "implementing" as const,
            label: "Implementing",
            status: "passed",
          },
          { key: "reviewing" as const, label: "Reviewing", status: "passed" },
          { key: "ci" as const, label: "CI", status: "pending" },
          {
            key: "ui_testing" as const,
            label: "UI Testing",
            status: "not_started",
          },
        ],
        checks: [
          {
            key: "ci",
            label: "CI",
            status: "pending",
            detail: "Awaiting CI evaluation.",
          },
          {
            key: "review_threads",
            label: "Review Threads",
            status: "passed",
            detail: "All clear.",
          },
        ],
        needsAttention: {
          isBlocked: false,
          blockerCount: 0,
          topBlockers: [],
        },
        links: {
          pullRequestUrl: "https://github.com/owner/repo/pull/123",
          statusCommentUrl: null,
          checkRunUrl: null,
        },
        artifacts: {
          planningArtifact: null,
          implementationArtifact: null,
          plannedTaskSummary: { total: 5, done: 2, remaining: 3 },
          plannedTasks: [],
        },
        updatedAtIso: "2024-01-01T00:00:00.000Z",
      };

      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(mockStatus);

      const result = await fetcher.fetchDeliveryLoopStatus("thread-123");

      expect(result.data).toBeDefined();
      expect(result.data!.checks).toBeDefined();
      expect(result.data!.checks.length).toBeGreaterThan(0);
    });

    it("should include links in successful response", async () => {
      // VAL-UI-007: Asserts that response includes comparator-required links field
      const mockStatus = {
        loopId: "loop-123",
        state: "done",
        planApprovalPolicy: "auto" as const,
        stateLabel: "Done",
        explanation: "Completed successfully.",
        progressPercent: 100,
        actions: {
          canResume: false,
          canBypassOnce: false,
          canApprovePlan: false,
        },
        phases: [
          { key: "planning" as const, label: "Planning", status: "passed" },
          {
            key: "implementing" as const,
            label: "Implementing",
            status: "passed",
          },
          { key: "reviewing" as const, label: "Reviewing", status: "passed" },
          { key: "ci" as const, label: "CI", status: "passed" },
          { key: "ui_testing" as const, label: "UI Testing", status: "passed" },
        ],
        checks: [],
        needsAttention: {
          isBlocked: false,
          blockerCount: 0,
          topBlockers: [],
        },
        links: {
          pullRequestUrl: "https://github.com/owner/repo/pull/123",
          statusCommentUrl:
            "https://github.com/owner/repo/pull/123#issuecomment-123",
          checkRunUrl: null,
        },
        artifacts: {
          planningArtifact: {
            id: "art-1",
            status: "accepted" as const,
            updatedAtIso: "2024-01-01T00:00:00.000Z",
            planText: "Test plan",
          },
          implementationArtifact: {
            id: "art-2",
            status: "accepted" as const,
            headSha: "abc123",
            updatedAtIso: "2024-01-01T00:00:00.000Z",
          },
          plannedTaskSummary: { total: 0, done: 0, remaining: 0 },
          plannedTasks: [],
        },
        updatedAtIso: "2024-01-01T00:00:00.000Z",
      };

      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(mockStatus);

      const result = await fetcher.fetchDeliveryLoopStatus("thread-123");

      expect(result.data).toBeDefined();
      expect(result.data!.links.pullRequestUrl).toBe(
        "https://github.com/owner/repo/pull/123",
      );
    });

    it("should include freshness timestamp in successful response", async () => {
      // VAL-UI-007: Asserts that response includes comparator-required freshness field
      const mockStatus = {
        loopId: "loop-123",
        state: "implementing",
        planApprovalPolicy: "auto" as const,
        stateLabel: "Implementing",
        explanation: "Agent is implementing.",
        progressPercent: 25,
        actions: {
          canResume: false,
          canBypassOnce: false,
          canApprovePlan: false,
        },
        phases: [],
        checks: [],
        needsAttention: {
          isBlocked: false,
          blockerCount: 0,
          topBlockers: [],
        },
        links: {
          pullRequestUrl: null,
          statusCommentUrl: null,
          checkRunUrl: null,
        },
        artifacts: {
          planningArtifact: null,
          implementationArtifact: null,
          plannedTaskSummary: { total: 0, done: 0, remaining: 0 },
          plannedTasks: [],
        },
        updatedAtIso: "2024-01-15T10:30:00.000Z",
      };

      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(mockStatus);

      const result = await fetcher.fetchDeliveryLoopStatus("thread-123");

      expect(result.data).toBeDefined();
      expect(result.data!.updatedAtIso).toBe("2024-01-15T10:30:00.000Z");
    });
  });

  describe("fetchAll", () => {
    it("should return both detail and deliveryLoop when available", async () => {
      const mockThread = {
        id: "thread-456",
        name: "Test Thread",
        status: "queued",
      };
      const mockStatus = {
        loopId: "loop-123",
        state: "implementing",
        planApprovalPolicy: "auto",
        stateLabel: "Implementing",
        explanation: "Agent is implementing.",
        progressPercent: 25,
        actions: {
          canResume: false,
          canBypassOnce: false,
          canApprovePlan: false,
        },
        phases: [],
        checks: [],
        needsAttention: {
          isBlocked: false,
          blockerCount: 0,
          topBlockers: [],
        },
        links: {
          pullRequestUrl: null,
          statusCommentUrl: null,
          checkRunUrl: null,
        },
        artifacts: {
          planningArtifact: null,
          implementationArtifact: null,
          plannedTaskSummary: { total: 0, done: 0, remaining: 0 },
          plannedTasks: [],
        },
        updatedAtIso: "2024-01-01T00:00:00.000Z",
      };

      mockClient.threads.detail.mockResolvedValueOnce(mockThread);
      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(mockStatus);

      const result = await fetcher.fetchAll("thread-456");

      expect(result.detail.data).toEqual(mockThread);
      // deliveryLoop is now included when the endpoint returns data
      expect(result.deliveryLoop).toBeDefined();
      expect(result.deliveryLoop?.data).toEqual(mockStatus);
    });

    it("should return only detail when delivery loop status is unavailable", async () => {
      const mockThread = {
        id: "thread-456",
        name: "Test Thread",
        status: "queued",
      };

      mockClient.threads.detail.mockResolvedValueOnce(mockThread);
      mockClient.threads.deliveryLoopStatus.mockResolvedValueOnce(null);

      const result = await fetcher.fetchAll("thread-456");

      expect(result.detail.data).toEqual(mockThread);
      // deliveryLoop is undefined when the endpoint returns null (no active delivery loop)
      expect(result.deliveryLoop).toBeUndefined();
    });

    it("should handle detail fetch error", async () => {
      mockClient.threads.detail.mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await fetcher.fetchAll("thread-456");

      expect(result.detail.error).toBe("Network error");
    });
  });
});
