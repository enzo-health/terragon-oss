import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const followUpMocks = vi.hoisted(() => ({
  dispatchFollowUpFromAppend: vi.fn(),
}));

const traceMocks = vi.hoisted(() => ({
  getTraceIdFromAgUiForwardedProps: vi.fn(),
  recordAgentTraceSpan: vi.fn(),
}));

vi.mock("@/server-lib/follow-up-command", () => ({
  dispatchFollowUpFromAppend: followUpMocks.dispatchFollowUpFromAppend,
}));

vi.mock("@/lib/agent-trace", () => ({
  getTraceIdFromAgUiForwardedProps: traceMocks.getTraceIdFromAgUiForwardedProps,
  recordAgentTraceSpan: traceMocks.recordAgentTraceSpan,
}));

import { handleAgUiPostCommand } from "./ag-ui-command-handler";

function makeRequest(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "hello" }],
    tools: [],
    context: [],
    ...overrides,
  };
}

const BASE_ARGS = {
  threadId: "thread-1",
  threadChatId: "chat-1",
  userId: "user-1",
  isReplayMode: false,
};

describe("handleAgUiPostCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    followUpMocks.dispatchFollowUpFromAppend.mockResolvedValue({
      runId: "run-dispatched",
    });
    traceMocks.getTraceIdFromAgUiForwardedProps.mockReturnValue(null);
  });

  it("opens the stream without parsing or dispatching in replay mode", async () => {
    const result = await handleAgUiPostCommand({
      ...BASE_ARGS,
      request: makeRequest("http://localhost/api/ag-ui/thread-1", makeBody()),
      isReplayMode: true,
    });

    expect(result).toEqual({ type: "open-stream" });
    expect(followUpMocks.dispatchFollowUpFromAppend).not.toHaveBeenCalled();
  });

  it("opens the stream for absent or invalid bodies", async () => {
    const result = await handleAgUiPostCommand({
      ...BASE_ARGS,
      request: makeRequest("http://localhost/api/ag-ui/thread-1"),
    });

    expect(result).toEqual({ type: "open-stream" });
    expect(followUpMocks.dispatchFollowUpFromAppend).not.toHaveBeenCalled();
  });

  it("dispatches append POSTs through the follow-up command", async () => {
    const body = makeBody();
    const request = makeRequest("http://localhost/api/ag-ui/thread-1", body);

    const result = await handleAgUiPostCommand({
      ...BASE_ARGS,
      request,
    });

    expect(result).toEqual({ type: "open-stream" });
    expect(followUpMocks.dispatchFollowUpFromAppend).toHaveBeenCalledWith({
      threadId: BASE_ARGS.threadId,
      threadChatId: BASE_ARGS.threadChatId,
      userId: BASE_ARGS.userId,
      body: expect.objectContaining({ runId: "run-1" }),
    });
  });

  it("treats cursor POSTs as resume and does not duplicate-dispatch the last user message", async () => {
    const request = makeRequest(
      "http://localhost/api/ag-ui/thread-1?fromSeq=42",
      makeBody(),
    );

    const result = await handleAgUiPostCommand({
      ...BASE_ARGS,
      request,
    });

    expect(result).toEqual({ type: "open-stream" });
    expect(followUpMocks.dispatchFollowUpFromAppend).not.toHaveBeenCalled();
  });

  it("lets explicit append intent win over a stale cursor", async () => {
    const body = makeBody({
      forwardedProps: {
        runConfig: {
          terragon: { intent: "append" },
        },
      },
    });
    const request = makeRequest(
      "http://localhost/api/ag-ui/thread-1?fromSeq=42",
      body,
    );

    await handleAgUiPostCommand({
      ...BASE_ARGS,
      request,
    });

    expect(followUpMocks.dispatchFollowUpFromAppend).toHaveBeenCalledOnce();
  });

  it("maps command errors to typed response results", async () => {
    followUpMocks.dispatchFollowUpFromAppend.mockResolvedValue({
      error: { kind: "lock-held" },
    });

    const result = await handleAgUiPostCommand({
      ...BASE_ARGS,
      request: makeRequest("http://localhost/api/ag-ui/thread-1", makeBody()),
    });

    expect(result).toEqual({
      type: "response",
      status: 409,
      body: { error: "Run already in progress" },
    });
  });
});
