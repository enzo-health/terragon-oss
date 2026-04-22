import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createTestUser: vi.fn(),
  createTestThread: vi.fn(),
  createWorkflow: vi.fn(),
  ensureWorkflowHead: vi.fn(),
  upsertAgentRunContext: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@terragon/shared/model/test-helpers", () => ({
  createTestUser: mocks.createTestUser,
  createTestThread: mocks.createTestThread,
}));

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  createWorkflow: mocks.createWorkflow,
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  ensureWorkflowHead: mocks.ensureWorkflowHead,
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  upsertAgentRunContext: mocks.upsertAgentRunContext,
}));

import { POST } from "./route";

function makeRequest(secret?: string): NextRequest {
  return new Request("http://localhost/api/test/task-liveness-scenario", {
    method: "POST",
    headers: secret ? { "X-Terragon-Secret": secret } : {},
  }) as NextRequest;
}

describe("task-liveness scenario route guard", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableFlag = process.env.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS;
  const originalSecret = process.env.TASK_LIVENESS_TEST_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
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

    const response = await POST(makeRequest("abc123"));

    expect(response.status).toBe(403);
    expect(mocks.createTestUser).not.toHaveBeenCalled();
  });

  it("returns 503 when test secret is not configured", async () => {
    const response = await POST(makeRequest("anything"));

    expect(response.status).toBe(503);
    expect(mocks.createTestUser).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid secret", async () => {
    process.env.TASK_LIVENESS_TEST_SECRET = "correct-secret";

    const response = await POST(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mocks.createTestUser).not.toHaveBeenCalled();
  });
});
