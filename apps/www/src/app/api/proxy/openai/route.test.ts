import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import * as aiSdkRoute from "./[[...path]]/route";
import { logOpenAIUsage } from "./log-openai-usage";
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

vi.mock("@terragon/env/apps-www", () => ({
  env: {
    OPENAI_API_KEY: "test-openai-key",
  },
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

vi.mock("./log-openai-usage", () => ({
  logOpenAIUsage: vi.fn(),
}));

const encoder = new TextEncoder();

function createRequest({
  method = "POST",
  headers = {},
  body,
  url = "https://example.com/api/proxy/openai",
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

describe("OpenAI proxy route", () => {
  const getDaemonTokenAuthContextOrNullMock = vi.mocked(
    getDaemonTokenAuthContextOrNull,
  );
  const hasDaemonProviderScopeMock = vi.mocked(hasDaemonProviderScope);
  const getUserCreditBalanceMock = vi.mocked(getUserCreditBalance);
  const getAgentRunContextByRunIdMock = vi.mocked(getAgentRunContextByRunId);
  const logUsageMock = vi.mocked(logOpenAIUsage);
  const { POST } = aiSdkRoute;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    const now = Date.now();
    const daemonRun: DaemonRunTokenClaims = {
      kind: "daemon-run" as const,
      runId: "run-openai-123",
      threadId: "thread-openai-123",
      threadChatId: "thread-chat-openai-123",
      sandboxId: "sandbox-openai-123",
      agent: "codex",
      transportMode: "legacy" as const,
      protocolVersion: 1,
      providers: ["openai"],
      nonce: "nonce-openai-123",
      issuedAt: now,
      exp: now + 60_000,
    };
    getDaemonTokenAuthContextOrNullMock.mockResolvedValue({
      userId: "user-123",
      keyId: "daemon-key-openai-123",
      claims: daemonRun,
    });
    hasDaemonProviderScopeMock.mockImplementation(
      (_claims, provider) => provider === "openai",
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
      daemonTokenKeyId: "daemon-key-openai-123",
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

  it("logs usage for chat completions JSON responses", async () => {
    const responsePayload = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-5.1-2025-04-14",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I assist you today?",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20,
      },
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
        model: "gpt-5.1-2025-04-14",
        messages: [{ role: "user", content: "hi" }],
      },
      url: "https://example.com/api/proxy/openai/v1/chat/completions",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect((fetchArgs[0] as URL).toString()).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    const headers = fetchArgs[1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer test-openai-key");

    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/v1/chat/completions",
      usage: responsePayload.usage,
      userId: "user-123",
      model: responsePayload.model,
    });
  });

  it("logs usage for responses API JSON responses", async () => {
    const responsePayload = {
      id: "resp_67cb71b351908190a308f3859487620d06981a8637e6bc44",
      object: "response",
      created_at: 1741386163,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: "gpt-5",
      output: [
        {
          type: "message",
          id: "msg_67cb71b3c2b0819084d481baaaf148f206981a8637e6bc44",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Silent circuits hum,  \nThoughts emerge in data streams—  \nDigital dawn breaks.",
              annotations: [],
            },
          ],
        },
      ],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoningText: {
        effort: null,
        summary: null,
      },
      store: true,
      temperature: 1,
      text: {
        format: { type: "text" },
      },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      truncation: "disabled",
      usage: {
        input_tokens: 32,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: 18,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
        total_tokens: 50,
      },
      user: null,
      metadata: {},
    };
    const fetchResponse = new Response(JSON.stringify(responsePayload), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: { model: "gpt-5", prompt: "hi" },
      url: "https://example.com/api/proxy/openai/v1/responses",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "responses"] }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect((fetchArgs[0] as URL).toString()).toBe(
      "https://api.openai.com/v1/responses",
    );
    const headers = fetchArgs[1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer test-openai-key");

    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/v1/responses",
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
        Authorization: "X-Daemon-Token alt-daemon-token",
      },
      body: { model: "gpt-5.1-2025-04-14", prompt: "hi" },
    });

    await POST(request, { params: Promise.resolve({}) });

    expect(getDaemonTokenAuthContextOrNullMock).toHaveBeenCalledTimes(1);
    const authRequest = getDaemonTokenAuthContextOrNullMock.mock
      .calls[0]![0] as { headers: Headers } | undefined;
    expect(authRequest?.headers.get("X-Daemon-Token")).toBe("alt-daemon-token");

    const fetchHeaders =
      (fetchMock.mock.calls[0]![1]!.headers as Headers) ?? new Headers();
    expect(fetchHeaders.get("Authorization")).toBe("Bearer test-openai-key");
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
    const response = await POST(request, { params: Promise.resolve({}) });

    expect(response.status).toBe(402);
    expect(await response.text()).toBe("Insufficient credits");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs usage for chat completions event streams", async () => {
    const events = [
      {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-5.1-2025-04-14",
        choices: [
          {
            index: 0,
            delta: {
              content: "Hello",
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-5.1-2025-04-14",
        choices: [
          {
            index: 0,
            delta: {
              content: " there!",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const data of events) {
          const chunk = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
      body: {
        model: "gpt-5.1-2025-04-14",
        messages: [{ role: "user", content: "hi" }],
      },
      url: "https://example.com/api/proxy/openai/v1/chat/completions",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    // Allow logging promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/v1/chat/completions",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      userId: "user-123",
      model: "gpt-5.1-2025-04-14",
    });

    const bodyText = await response.text();
    expect(bodyText).toContain("chatcmpl-123");
  });

  it("rejects requests with non-GPT-5.1 models", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gpt-4o-2024-08-06",
        messages: [{ role: "user", content: "hi" }],
      },
      url: "https://example.com/api/proxy/openai/v1/chat/completions",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Only GPT-5 models are supported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with gpt-3.5-turbo", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: "hi" }],
      },
      url: "https://example.com/api/proxy/openai/v1/chat/completions",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Only GPT-5 models are supported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests without a model specified", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        messages: [{ role: "user", content: "hi" }],
      },
      url: "https://example.com/api/proxy/openai/v1/chat/completions",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Model must be specified in request body",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts requests with gpt-5.1 model", async () => {
    const responsePayload = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-5.1-2025-04-14",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello!",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
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
        model: "gpt-5.1-2025-04-14",
        messages: [{ role: "user", content: "hi" }],
      },
      url: "https://example.com/api/proxy/openai/v1/chat/completions",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs usage for response.completed events in event streams", async () => {
    const events = [
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: {
            id: "resp_67c9fdcecf488190bdd9a0409de3a1ec07b8b0ad4e5eb654",
            object: "response",
            created_at: 1741290958,
            status: "in_progress",
            error: null,
            incomplete_details: null,
            instructions: "You are a helpful assistant.",
            max_output_tokens: null,
            model: "gpt-5",
            output: [],
            parallel_tool_calls: true,
            previous_response_id: null,
            reasoningText: { effort: null, summary: null },
            store: true,
            temperature: 1,
            text: { format: { type: "text" } },
            tool_choice: "auto",
            tools: [],
            top_p: 1,
            truncation: "disabled",
            usage: null,
            user: null,
            metadata: {},
          },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          item_id: "msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654",
          output_index: 0,
          content_index: 0,
          delta: "Hi",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_67c9fdcecf488190bdd9a0409de3a1ec07b8b0ad4e5eb654",
            object: "response",
            created_at: 1741290958,
            status: "completed",
            error: null,
            incomplete_details: null,
            instructions: "You are a helpful assistant.",
            max_output_tokens: null,
            model: "gpt-5",
            output: [
              {
                id: "msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Hi there! How can I assist you today?",
                    annotations: [],
                  },
                ],
              },
            ],
            parallel_tool_calls: true,
            previous_response_id: null,
            reasoningText: { effort: null, summary: null },
            store: true,
            temperature: 1,
            text: { format: { type: "text" } },
            tool_choice: "auto",
            tools: [],
            top_p: 1,
            truncation: "disabled",
            usage: {
              input_tokens: 37,
              output_tokens: 11,
              output_tokens_details: {
                reasoning_tokens: 0,
              },
              total_tokens: 48,
            },
            user: null,
            metadata: {},
          },
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
      body: {
        model: "gpt-5",
        prompt: "hi",
      },
      url: "https://example.com/api/proxy/openai/v1/responses",
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["v1", "responses"] }),
    });

    // Allow logging promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logUsageMock).toHaveBeenCalledWith({
      path: "/v1/responses",
      responseId: "resp_67c9fdcecf488190bdd9a0409de3a1ec07b8b0ad4e5eb654",
      usage: {
        input_tokens: 37,
        output_tokens: 11,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
        total_tokens: 48,
      },
      userId: "user-123",
      model: "gpt-5",
    });

    const bodyText = await response.text();
    expect(bodyText).toContain("response.completed");
  });
});
