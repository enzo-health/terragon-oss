import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn((): boolean => true),
  handleAgentSessionEvent: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: {
    LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
  },
}));

vi.mock("@linear/sdk/webhooks", () => ({
  LINEAR_WEBHOOK_SIGNATURE_HEADER: "linear-signature",
  LINEAR_WEBHOOK_TS_HEADER: "linear-timestamp",
  LinearWebhookClient: vi.fn(() => ({
    verify: mocks.verify,
  })),
}));

vi.mock("./handlers", () => ({
  handleAgentSessionEvent: mocks.handleAgentSessionEvent,
  handleAppUserNotification: vi.fn(async (): Promise<void> => undefined),
  handleOAuthAppRevoked: vi.fn(async (): Promise<void> => undefined),
  handlePermissionChange: vi.fn(async (): Promise<void> => undefined),
}));

import { POST } from "./route";

function makeRequest(
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    text: vi.fn(async () => body),
    headers: {
      get: vi.fn((name: string) => normalizedHeaders.get(name.toLowerCase())),
    },
  } as unknown as NextRequest;
}

describe("Linear webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(true);
  });

  it("rejects requests with invalid Linear signatures", async () => {
    mocks.verify.mockReturnValueOnce(false);
    const response = await POST(
      makeRequest("{}", {
        "linear-signature": "bad-signature",
        "linear-timestamp": "123",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON after signature verification", async () => {
    const response = await POST(
      makeRequest("{", {
        "linear-signature": "valid-signature",
        "linear-timestamp": "123",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("dispatches valid AgentSessionEvent payloads with the delivery id", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-123",
      agentSession: { id: "session-123" },
    };

    const response = await POST(
      makeRequest(JSON.stringify(payload), {
        "linear-delivery": "delivery-123",
        "linear-signature": "valid-signature",
        "linear-timestamp": "123",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledWith(
      payload,
      "delivery-123",
    );
  });
});
