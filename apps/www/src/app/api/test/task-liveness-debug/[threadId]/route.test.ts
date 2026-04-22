import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mutableEnv = process.env as Record<string, string | undefined>;

const mocks = vi.hoisted(() => ({
  getTaskLivenessDebugPayloadForSecretScopedRoute: vi.fn(),
}));

vi.mock("@/server-actions/admin/task-liveness-debug", () => ({
  getTaskLivenessDebugPayloadForSecretScopedRoute:
    mocks.getTaskLivenessDebugPayloadForSecretScopedRoute,
}));

import { GET } from "./route";

function makeRequest(secret?: string): NextRequest {
  return new Request("http://localhost/api/test/task-liveness-debug/thread-1", {
    method: "GET",
    headers: secret ? { "X-Terragon-Secret": secret } : {},
  }) as NextRequest;
}

describe("task-liveness debug route guard", () => {
  const originalNodeEnv = mutableEnv.NODE_ENV;
  const originalEnableFlag = mutableEnv.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS;
  const originalSecret = mutableEnv.TASK_LIVENESS_TEST_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskLivenessDebugPayloadForSecretScopedRoute.mockResolvedValue({
      summary: "ok",
      ui: {
        threadChatStatus: "complete",
        deliveryLoopState: null,
        effectiveThreadStatus: "complete",
        isWorking: false,
        canApplyDeliveryLoopHeadOverride: false,
      },
    });
    mutableEnv.NODE_ENV = "test";
    delete mutableEnv.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS;
    delete mutableEnv.TASK_LIVENESS_TEST_SECRET;
  });

  afterEach(() => {
    mutableEnv.NODE_ENV = originalNodeEnv;
    mutableEnv.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS = originalEnableFlag;
    mutableEnv.TASK_LIVENESS_TEST_SECRET = originalSecret;
  });

  it("returns 403 in development when explicit opt-in is missing", async () => {
    mutableEnv.NODE_ENV = "development";
    mutableEnv.TASK_LIVENESS_TEST_SECRET = "abc123";

    const response = await GET(makeRequest("abc123"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(403);
    expect(
      mocks.getTaskLivenessDebugPayloadForSecretScopedRoute,
    ).not.toHaveBeenCalled();
  });

  it("returns 503 when test secret is not configured", async () => {
    const response = await GET(makeRequest("anything"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(503);
    expect(
      mocks.getTaskLivenessDebugPayloadForSecretScopedRoute,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid secret", async () => {
    mutableEnv.TASK_LIVENESS_TEST_SECRET = "correct-secret";

    const response = await GET(makeRequest("wrong-secret"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(401);
    expect(
      mocks.getTaskLivenessDebugPayloadForSecretScopedRoute,
    ).not.toHaveBeenCalled();
  });

  it("returns debug payload via secret-scoped helper for valid secret", async () => {
    mutableEnv.TASK_LIVENESS_TEST_SECRET = "correct-secret";

    const response = await GET(makeRequest("correct-secret"), {
      params: Promise.resolve({ threadId: "thread-1" }),
    });

    expect(response.status).toBe(200);
    expect(
      mocks.getTaskLivenessDebugPayloadForSecretScopedRoute,
    ).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });
});
