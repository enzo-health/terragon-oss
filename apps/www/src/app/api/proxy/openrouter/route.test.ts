import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import * as aiSdkRoute from "./[[...path]]/route";
import { logOpenRouterUsage } from "./log-usage";
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
    OPENROUTER_API_KEY: "test-openrouter-key",
  },
}));

vi.mock("./log-usage", () => ({
  logOpenRouterUsage: vi.fn(),
}));

const encoder = new TextEncoder();

function createRequest({
  method = "POST",
  headers = {},
  body,
  url = "https://example.com/api/proxy/ai-sdk",
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
    /^\s*Bearer\s+/i.test(mergedHeaders.get("authorization") ?? "");

  if (includeDefaultToken && !hasDaemonToken) {
    mergedHeaders.set("X-Daemon-Token", "test-daemon-token");
  }

  const arrayBuffer =
    body === undefined
      ? vi.fn().mockResolvedValue(new ArrayBuffer(0))
      : vi.fn().mockResolvedValue(encoder.encode(JSON.stringify(body)).buffer);

  return {
    method,
    headers: mergedHeaders,
    nextUrl: new URL(url),
    arrayBuffer,
  } as unknown as NextRequest;
}

describe("OpenRouter proxy route", () => {
  const getDaemonTokenAuthContextOrNullMock = vi.mocked(
    getDaemonTokenAuthContextOrNull,
  );
  const hasDaemonProviderScopeMock = vi.mocked(hasDaemonProviderScope);
  const getUserCreditBalanceMock = vi.mocked(getUserCreditBalance);
  const getAgentRunContextByRunIdMock = vi.mocked(getAgentRunContextByRunId);
  const logUsageMock = vi.mocked(logOpenRouterUsage);
  const { POST } = aiSdkRoute;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    const now = Date.now();
    const daemonRun: DaemonRunTokenClaims = {
      kind: "daemon-run" as const,
      runId: "run-openrouter-123",
      threadId: "thread-openrouter-123",
      threadChatId: "thread-chat-openrouter-123",
      sandboxId: "sandbox-openrouter-123",
      agent: "opencode",
      transportMode: "legacy" as const,
      protocolVersion: 1,
      providers: ["openrouter"],
      nonce: "nonce-openrouter-123",
      issuedAt: now,
      exp: now + 60_000,
    };
    getDaemonTokenAuthContextOrNullMock.mockResolvedValue({
      userId: "user-123",
      keyId: "daemon-key-openrouter-123",
      claims: daemonRun,
    });
    hasDaemonProviderScopeMock.mockImplementation(
      (_claims, provider) => provider === "openrouter",
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
      daemonTokenKeyId: "daemon-key-openrouter-123",
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
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "qwen/qwen3-coder:exacto",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello!",
          },
          finish_reason: "stop",
          index: 0,
        },
      ],
    };

    const fetchResponse = new Response(JSON.stringify(responsePayload), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "qwen/qwen3-coder:exacto",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const response = await POST(request, {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect((fetchArgs[0] as URL).toString()).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const headers = fetchArgs[1]!.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-openrouter-key");

    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/api/v1/chat/completions",
      usage: responsePayload.usage,
      userId: "user-123",
      model: responsePayload.model,
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
      body: { model: "qwen/qwen3-coder:exacto", messages: [] },
    });

    await POST(request, {
      params: Promise.resolve({}),
    });

    expect(getDaemonTokenAuthContextOrNullMock).toHaveBeenCalledTimes(1);
    const authRequest = getDaemonTokenAuthContextOrNullMock.mock
      .calls[0]![0] as { headers: Headers } | undefined;
    expect(authRequest?.headers.get("X-Daemon-Token")).toBe(
      "another-daemon-token",
    );

    const fetchHeaders =
      (fetchMock.mock.calls[0]![1]!.headers as Headers) ?? new Headers();
    expect(fetchHeaders.get("Authorization")).toBe(
      "Bearer test-openrouter-key",
    );
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
    const response = await POST(request, {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(402);
    expect(await response.text()).toBe("Insufficient credits");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs usage for streaming responses", async () => {
    const events = [
      {
        data: JSON.stringify({
          id: "chatcmpl-123",
          object: "chat.completion.chunk",
          created: 1677652288,
          model: "qwen/qwen3-coder:exacto",
          choices: [
            {
              index: 0,
              delta: {
                content: "Hello",
              },
              finish_reason: null,
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-123",
          object: "chat.completion.chunk",
          created: 1677652288,
          model: "qwen/qwen3-coder:exacto",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        }),
      },
      {
        data: "[DONE]",
      },
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { data } of events) {
          const chunk = `data: ${data}\n\n`;
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
      body: { model: "qwen/qwen3-coder:exacto", messages: [] },
    });
    const response = await POST(request, {
      params: Promise.resolve({}),
    });

    // Consume the response stream to allow the logging stream to process
    const bodyText = await response.text();
    expect(bodyText).toContain("chatcmpl-123");

    // Wait for async logging to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/api/v1/chat/completions",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
      userId: "user-123",
      model: "qwen/qwen3-coder:exacto",
    });
  });

  it("forwards custom paths correctly", async () => {
    const fetchResponse = new Response(JSON.stringify({}), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      url: "https://example.com/api/proxy/ai-sdk/v1/completions",
      body: { model: "qwen/qwen3-coder:exacto", prompt: "Hello" },
    });

    await POST(request, {
      params: Promise.resolve({ path: ["v1", "completions"] }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect((fetchArgs[0] as URL).toString()).toBe(
      "https://openrouter.ai/api/v1/completions",
    );
  });

  it("rejects requests missing the model field", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({ body: { messages: [] } });
    const response = await POST(request, {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Model must be specified in request body",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with unsupported OpenRouter models", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: { model: "anthropic/claude-3-5-sonnet-20241022", messages: [] },
    });
    const response = await POST(request, {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid model requested");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
