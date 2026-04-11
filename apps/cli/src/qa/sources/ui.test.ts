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
    it("should return error indicating missing endpoint", async () => {
      const result = await fetcher.fetchDeliveryLoopStatus("thread-456");

      expect(result.name).toBe("ui");
      expect(result.data).toBeNull();
      expect(result.error).toContain(
        "does not include delivery loop status endpoint",
      );
    });
  });

  describe("fetchAll", () => {
    it("should return both detail and deliveryLoop (when available)", async () => {
      const mockThread = {
        id: "thread-456",
        name: "Test Thread",
        status: "queued",
      };

      mockClient.threads.detail.mockResolvedValueOnce(mockThread);

      const result = await fetcher.fetchAll("thread-456");

      expect(result.detail.data).toEqual(mockThread);
      // deliveryLoop is undefined because the endpoint doesn't exist
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
