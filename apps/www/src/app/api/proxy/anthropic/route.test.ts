import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import * as aiSdkRoute from "./[[...path]]/route";
import { logAnthropicUsage } from "./log-anthropic-usage";
import {
  getDaemonTokenAuthContextOrNull,
  hasDaemonProviderScope,
  type DaemonRunTokenClaims,
} from "@/lib/auth-server";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn(),
  hasDaemonProviderScope: vi.fn(),
}));

vi.mock("@terragon/shared/model/credits", () => ({
  getUserCreditBalance: vi.fn(),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn(),
}));

vi.mock("@/server-lib/credit-auto-reload", () => ({
  maybeTriggerCreditAutoReload: vi.fn(),
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: {
    ANTHROPIC_API_KEY: "test-anthropic-key",
  },
}));

vi.mock("./log-anthropic-usage", () => ({
  logAnthropicUsage: vi.fn(),
}));

const encoder = new TextEncoder();
const VALID_MODEL = "claude-3-5-sonnet-20241022";

function createRequest({
  method = "POST",
  headers = {},
  body,
  url = "https://example.com/api/proxy/anthropic",
  includeDefaultToken = true,
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  url?: string;
  includeDefaultToken?: boolean;
} = {}): NextRequest {
  const mergedHeaders = new Headers(headers);

  const hasDaemonToken =
    mergedHeaders.has("X-Daemon-Token") ||
    /^(?:x-daemon-token|bearer)\s+/i.test(
      mergedHeaders.get("authorization") ?? "",
    );

  if (includeDefaultToken && !hasDaemonToken) {
    mergedHeaders.set("X-Daemon-Token", "test-daemon-token");
  }

  const arrayBuffer =
    body === undefined
      ? vi.fn().mockResolvedValue(new ArrayBuffer(0))
      : vi.fn().mockResolvedValue(encoder.encode(JSON.stringify(body)).buffer);

  const mockRequest = {
    method,
    headers: mergedHeaders,
    nextUrl: new URL(url),
    arrayBuffer,
    clone() {
      return mockRequest;
    },
  } as unknown as NextRequest;

  return mockRequest;
}

describe("Anthropic proxy route", () => {
  const getDaemonTokenAuthContextOrNullMock = vi.mocked(
    getDaemonTokenAuthContextOrNull,
  );
  const hasDaemonProviderScopeMock = vi.mocked(hasDaemonProviderScope);
  const getUserCreditBalanceMock = vi.mocked(getUserCreditBalance);
  const getAgentRunContextByRunIdMock = vi.mocked(getAgentRunContextByRunId);
  const logUsageMock = vi.mocked(logAnthropicUsage);
  const { POST } = aiSdkRoute;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    const now = Date.now();
    const daemonRun: DaemonRunTokenClaims = {
      kind: "daemon-run" as const,
      runId: "run-anthropic-123",
      threadId: "thread-anthropic-123",
      threadChatId: "thread-chat-anthropic-123",
      sandboxId: "sandbox-anthropic-123",
      agent: "claudeCode",
      transportMode: "legacy" as const,
      protocolVersion: 1,
      providers: ["anthropic"],
      nonce: "nonce-anthropic-123",
      issuedAt: now,
      exp: now + 60_000,
    };
    getDaemonTokenAuthContextOrNullMock.mockResolvedValue({
      userId: "user-123",
      keyId: "daemon-key-anthropic-123",
      claims: daemonRun,
    });
    hasDaemonProviderScopeMock.mockImplementation(
      (_claims, provider) => provider === "anthropic",
    );
    getAgentRunContextByRunIdMock.mockResolvedValue({
      runId: daemonRun.runId,
      threadId: daemonRun.threadId,
      threadChatId: daemonRun.threadChatId,
      sandboxId: daemonRun.sandboxId,
      agent: daemonRun.agent,
      transportMode: daemonRun.transportMode,
      protocolVersion: daemonRun.protocolVersion,
      tokenNonce: daemonRun.nonce,
      daemonTokenKeyId: "daemon-key-anthropic-123",
      status: "dispatched",
    } as any);
    getUserCreditBalanceMock.mockResolvedValue({
      totalCreditsCents: 1_000,
      totalUsageCents: 0,
      balanceCents: 1_000,
    });
    logUsageMock.mockReset();
    logUsageMock.mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs usage for JSON responses", async () => {
    const responsePayload = {
      id: "msg_01hxy0z6m4msj4n6crb2p0cqgw",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 300,
        output_tokens: 850,
      },
      content: [],
    };

    const fetchResponse = new Response(JSON.stringify(responsePayload), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: { model: VALID_MODEL, messages: [] },
    });
    const response = await POST(request, { params: {} });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect((fetchArgs[0] as URL).toString()).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    const headers = fetchArgs[1]!.headers as Headers;
    expect(headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");

    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/v1/messages",
      usage: responsePayload.usage,
      userId: "user-123",
      model: responsePayload.model,
      messageId: responsePayload.id,
    });
  });

  it("authorizes requests using the Authorization header token", async () => {
    const fetchResponse = new Response(JSON.stringify({}), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      includeDefaultToken: false,
      headers: {
        Authorization: "Bearer another-daemon-token",
      },
      body: { model: VALID_MODEL, messages: [] },
    });

    await POST(request, { params: {} });

    expect(getDaemonTokenAuthContextOrNullMock).toHaveBeenCalledTimes(1);
    const authRequest = getDaemonTokenAuthContextOrNullMock.mock
      .calls[0]![0] as { headers: Headers } | undefined;
    expect(authRequest?.headers.get("X-Daemon-Token")).toBe(
      "another-daemon-token",
    );

    const fetchHeaders =
      (fetchMock.mock.calls[0]![1]!.headers as Headers) ?? new Headers();
    expect(fetchHeaders.get("Authorization")).toBeNull();
  });

  it("rejects requests when user has no remaining credits", async () => {
    getUserCreditBalanceMock.mockResolvedValueOnce({
      totalCreditsCents: 0,
      totalUsageCents: 0,
      balanceCents: 0,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest();
    const response = await POST(request, { params: {} });

    expect(response.status).toBe(402);
    expect(await response.text()).toBe("Insufficient credits");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs usage for message_delta events in event streams", async () => {
    const events = [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_01j0h6rj5n7tfn0r5x0k2vqxga",
            model: "claude-3-5-sonnet-20241022",
          },
        },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: {
            id: "cb_01j0h6rj8y2d8b2c7x7jvph9c3",
            type: "text",
          },
        },
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          usage: {
            input_tokens: 1200,
            cache_creation_input_tokens: 400,
            cache_read_input_tokens: 300,
            output_tokens: 850,
          },
        },
      },
      {
        event: "message_stop",
        data: {
          type: "message_stop",
        },
      },
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { event, data } of events) {
          const chunk =
            `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const fetchResponse = new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: { model: VALID_MODEL, messages: [] },
    });
    const response = await POST(request, { params: {} });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/v1/messages",
      usage: events[2]!.data.usage,
      userId: "user-123",
      model: "claude-3-5-sonnet-20241022",
      messageId: "msg_01j0h6rj5n7tfn0r5x0k2vqxga",
    });

    const bodyText = await response.text();
    expect(bodyText).toContain("message_delta");
  });

  it("rejects requests with unsupported Claude models", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: { model: "claude-3-5-mini", messages: [] },
    });
    const response = await POST(request, { params: {} });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Claude Sonnet, Haiku, or Opus");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests missing the model field", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({ body: { messages: [] } });
    const response = await POST(request, { params: {} });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Model must be specified in request body",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
