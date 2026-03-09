import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = vi.hoisted(() => ({
  hset: vi.fn(),
  hgetall: vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: mockRedis,
}));

import {
  createDispatchIntent,
  buildDispatchIntentId,
  updateDispatchIntent,
  getActiveDispatchIntent,
  completeDispatchIntent,
} from "./dispatch-intent";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
});

describe("buildDispatchIntentId", () => {
  it("returns di_{loopId}_{runId}", () => {
    expect(buildDispatchIntentId("loop-1", "run-1")).toBe("di_loop-1_run-1");
  });
});

describe("createDispatchIntent", () => {
  it("persists intent to Redis with correct key and TTL", async () => {
    mockRedis.hset.mockResolvedValue("OK");
    mockRedis.expire.mockResolvedValue(1);

    const intent = await createDispatchIntent({
      loopId: "loop-1",
      threadId: "thread-1",
      threadChatId: "tc-1",
      targetPhase: "implementing",
      selectedAgent: "claudeCode",
      executionClass: "implementation_runtime",
      dispatchMechanism: "self_dispatch",
      runId: "run-1",
      maxRetries: 3,
    });

    expect(intent.id).toBe("di_loop-1_run-1");
    expect(intent.status).toBe("prepared");
    expect(intent.retryCount).toBe(0);
    expect(intent.lastError).toBeNull();
    expect(intent.lastFailureCategory).toBeNull();

    expect(mockRedis.hset).toHaveBeenCalledWith(
      "dl:dispatch:tc-1",
      expect.objectContaining({
        id: "di_loop-1_run-1",
        loopId: "loop-1",
        threadChatId: "tc-1",
        status: "prepared",
        selectedAgent: "claudeCode",
        executionClass: "implementation_runtime",
        dispatchMechanism: "self_dispatch",
      }),
    );
    expect(mockRedis.expire).toHaveBeenCalledWith("dl:dispatch:tc-1", 3600);
  });

  it("serializes dates as ISO strings", async () => {
    mockRedis.hset.mockResolvedValue("OK");
    mockRedis.expire.mockResolvedValue(1);

    await createDispatchIntent({
      loopId: "loop-2",
      threadId: "thread-2",
      threadChatId: "tc-2",
      targetPhase: "review_gate",
      selectedAgent: "codex",
      executionClass: "gate_runtime",
      dispatchMechanism: "queue_fallback",
      runId: "run-2",
      maxRetries: 5,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hashArg = (mockRedis.hset.mock.calls[0] as any)[1] as Record<
      string,
      string
    >;
    expect(hashArg.createdAt).toBe("2026-03-09T12:00:00.000Z");
    expect(hashArg.updatedAt).toBe("2026-03-09T12:00:00.000Z");
  });
});

describe("updateDispatchIntent", () => {
  it("merges partial updates and bumps updatedAt", async () => {
    mockRedis.hset.mockResolvedValue("OK");

    await updateDispatchIntent("di_loop-1_run-1", "tc-1", {
      status: "dispatched",
      retryCount: 1,
    });

    expect(mockRedis.hset).toHaveBeenCalledWith("dl:dispatch:tc-1", {
      updatedAt: "2026-03-09T12:00:00.000Z",
      status: "dispatched",
      retryCount: "1",
    });
  });

  it("serializes null lastError as empty string", async () => {
    mockRedis.hset.mockResolvedValue("OK");

    await updateDispatchIntent("di_loop-1_run-1", "tc-1", {
      lastError: null,
      lastFailureCategory: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hashArg = (mockRedis.hset.mock.calls[0] as any)[1] as Record<
      string,
      string
    >;
    expect(hashArg.lastError).toBe("");
    expect(hashArg.lastFailureCategory).toBe("");
  });

  it("serializes error details", async () => {
    mockRedis.hset.mockResolvedValue("OK");

    await updateDispatchIntent("di_loop-1_run-1", "tc-1", {
      status: "failed",
      lastError: "connection timeout",
      lastFailureCategory: "daemon_unreachable",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hashArg = (mockRedis.hset.mock.calls[0] as any)[1] as Record<
      string,
      string
    >;
    expect(hashArg.status).toBe("failed");
    expect(hashArg.lastError).toBe("connection timeout");
    expect(hashArg.lastFailureCategory).toBe("daemon_unreachable");
  });
});

describe("getActiveDispatchIntent", () => {
  it("returns typed intent when key exists", async () => {
    mockRedis.hgetall.mockResolvedValue({
      id: "di_loop-1_run-1",
      loopId: "loop-1",
      threadChatId: "tc-1",
      targetPhase: "implementing",
      selectedAgent: "claudeCode",
      executionClass: "implementation_runtime",
      dispatchMechanism: "self_dispatch",
      runId: "run-1",
      status: "dispatched",
      retryCount: "0",
      maxRetries: "3",
      createdAt: "2026-03-09T12:00:00.000Z",
      updatedAt: "2026-03-09T12:00:00.000Z",
      lastError: "",
      lastFailureCategory: "",
    });

    const intent = await getActiveDispatchIntent("tc-1");

    expect(intent).not.toBeNull();
    expect(intent!.id).toBe("di_loop-1_run-1");
    expect(intent!.retryCount).toBe(0);
    expect(intent!.maxRetries).toBe(3);
    expect(intent!.createdAt).toEqual(new Date("2026-03-09T12:00:00.000Z"));
    expect(intent!.lastError).toBeNull();
    expect(intent!.lastFailureCategory).toBeNull();
  });

  it("returns null when key does not exist", async () => {
    mockRedis.hgetall.mockResolvedValue(null);

    const intent = await getActiveDispatchIntent("tc-nonexistent");
    expect(intent).toBeNull();
  });

  it("returns null when hgetall returns empty object", async () => {
    mockRedis.hgetall.mockResolvedValue({});

    const intent = await getActiveDispatchIntent("tc-expired");
    expect(intent).toBeNull();
  });
});

describe("completeDispatchIntent", () => {
  it("sets status to completed and applies short TTL", async () => {
    mockRedis.hset.mockResolvedValue("OK");
    mockRedis.expire.mockResolvedValue(1);

    await completeDispatchIntent("di_loop-1_run-1", "tc-1");

    expect(mockRedis.hset).toHaveBeenCalledWith("dl:dispatch:tc-1", {
      status: "completed",
      updatedAt: "2026-03-09T12:00:00.000Z",
    });
    expect(mockRedis.expire).toHaveBeenCalledWith("dl:dispatch:tc-1", 300);
  });
});
