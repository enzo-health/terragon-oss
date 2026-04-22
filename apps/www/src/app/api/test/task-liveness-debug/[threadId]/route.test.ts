import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getTaskLivenessDebugPayload: vi.fn(),
}));

vi.mock("@/server-actions/admin/task-liveness-debug", () => ({
  getTaskLivenessDebugPayload: mocks.getTaskLivenessDebugPayload,
}));

import { GET } from "./route";

function makeRequest(secret?: string): NextRequest {
  return new Request("http://localhost/api/test/task-liveness-debug/thread-1", {
    method: "GET",
    headers: secret ? { "X-Terragon-Secret": secret } : {},
  }) as NextRequest;
}

describe("task-liveness debug route guard", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableFlag = process.env.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS;
  const originalSecret = process.env.TASK_LIVENESS_TEST_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskLivenessDebugPayload.mockResolvedValue({
      summary: "ok",
      ui: {
        threadChatStatus: "complete",
        deliveryLoopState: null,
        effectiveThreadStatus: "complete",
        isWorking: false,
        canApplyDeliveryLoopHeadOverride: false,
      },
    });
    process.env.NODE_ENV = "test";
    delete process.env.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS;
    delete process.env.TASK_LIVENESS_TEST_SECRET;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS = originalEnableFlag;
    process.env.TASK_LIVENESS_TEST_SECRET = originalSecret;
  });

  it("returns 403 in development when explicit opt-in is missing", async () => {
    process.env.NODE_ENV = "development";
    process.env.TASK_LIVENESS_TEST_SECRET = "abc123";

    const response = await GET(makeRequest("abc123"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(403);
    expect(mocks.getTaskLivenessDebugPayload).not.toHaveBeenCalled();
  });

  it("returns 503 when test secret is not configured", async () => {
    const response = await GET(makeRequest("anything"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(503);
    expect(mocks.getTaskLivenessDebugPayload).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid secret", async () => {
    process.env.TASK_LIVENESS_TEST_SECRET = "correct-secret";

    const response = await GET(makeRequest("wrong-secret"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(401);
    expect(mocks.getTaskLivenessDebugPayload).not.toHaveBeenCalled();
  });
});
