import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as schema from "@terragon/shared/db/schema";

const mutableEnv = process.env as Record<string, string | undefined>;

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
  const originalNodeEnv = mutableEnv.NODE_ENV;
  const originalEnableFlag = mutableEnv.ENABLE_TASK_LIVENESS_TEST_ENDPOINTS;
  const originalSecret = mutableEnv.TASK_LIVENESS_TEST_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
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
    mutableEnv.TASK_LIVENESS_TEST_SECRET = "correct-secret";

    const response = await POST(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mocks.createTestUser).not.toHaveBeenCalled();
  });

  it("seeds scenario without elevating user role to admin", async () => {
    mutableEnv.TASK_LIVENESS_TEST_SECRET = "correct-secret";

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const updateMock = vi.fn().mockReturnValue({
      set: setMock,
    });
    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn().mockReturnValue({
      values: insertValuesMock,
    });

    const dbMockModule = await import("@/lib/db");
    vi.mocked(dbMockModule.db.update).mockImplementation(updateMock);
    vi.mocked(dbMockModule.db.insert).mockImplementation(insertMock);

    mocks.createTestUser.mockResolvedValue({
      user: { id: "user-1" },
      session: { token: "session-token-1" },
    });
    mocks.createTestThread.mockResolvedValue({
      threadId: "thread-1",
      threadChatId: "chat-1",
    });
    mocks.createWorkflow.mockResolvedValue({ id: "workflow-1" });
    mocks.ensureWorkflowHead.mockResolvedValue(undefined);
    mocks.upsertAgentRunContext.mockResolvedValue(undefined);

    const response = await POST(makeRequest("correct-secret"));
    const body = (await response.json()) as {
      userId: string;
      sessionToken: string;
    };

    expect(response.status).toBe(201);
    expect(body.userId).toBe("user-1");
    expect(body.sessionToken).toBe("session-token-1");
    expect(updateMock).toHaveBeenCalledWith(schema.thread);
    expect(updateMock).toHaveBeenCalledWith(schema.threadChat);
    expect(updateMock).not.toHaveBeenCalledWith(schema.user);
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin" }),
    );
  });
});
