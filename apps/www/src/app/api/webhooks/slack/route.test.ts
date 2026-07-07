import crypto from "crypto";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    SLACK_SIGNING_SECRET: "slack-signing-secret",
  },
  handleAppMentionEvent: vi.fn(async (): Promise<void> => undefined),
  handleSlackMessageEvent: vi.fn(async (): Promise<void> => undefined),
  waitUntil: vi.fn(),
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: mocks.env,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("./handlers", () => ({
  handleAppMentionEvent: mocks.handleAppMentionEvent,
}));

vi.mock("@/server-lib/slack/slack-router", () => ({
  handleSlackMessageEvent: mocks.handleSlackMessageEvent,
}));

import { POST } from "./route";

function signSlackBody({
  body,
  timestamp = String(Math.floor(Date.now() / 1000)),
  secret = mocks.env.SLACK_SIGNING_SECRET,
}: {
  body: string;
  timestamp?: string;
  secret?: string;
}) {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return {
    timestamp,
    signature: `v0=${hmac}`,
  };
}

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

function makeSignedRequest(body: string): NextRequest {
  const { timestamp, signature } = signSlackBody({ body });
  return makeRequest(body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  });
}

describe("Slack webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
    delete process.env.VERCEL_ENV;
  });

  it("fails closed in deployed environments when the signing secret is unset", async () => {
    mocks.env.SLACK_SIGNING_SECRET = "";
    process.env.VERCEL_ENV = "preview";

    const response = await POST(
      makeRequest(
        JSON.stringify({
          event: { type: "app_mention", user: "U1", ts: "1.1", channel: "C1" },
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(mocks.handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures", async () => {
    const response = await POST(
      makeRequest("{}", {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=bad",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("rejects signed routes with missing Slack signature headers", async () => {
    const response = await POST(makeRequest("{}"));

    expect(response.status).toBe(401);
    expect(mocks.handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON after signature verification", async () => {
    const response = await POST(makeSignedRequest("{"));

    expect(response.status).toBe(400);
    expect(mocks.handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("schedules valid app mentions with the Slack event id", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@B123> fix this",
        ts: "1234567890.123456",
        channel: "C123",
        team: "T123",
      },
    });

    const response = await POST(makeSignedRequest(body));

    expect(response.status).toBe(200);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.handleAppMentionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user: "U123",
        ts: "1234567890.123456",
        team: "T123",
        slackEventId: "Ev123",
      }),
    );
  });

  it("accepts Slack app mentions that put the team id on the top-level payload", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      team_id: "T123",
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@B123> fix this",
        ts: "1234567890.123456",
        channel: "C123",
      },
    });

    const response = await POST(makeSignedRequest(body));

    expect(response.status).toBe(200);
    expect(mocks.handleAppMentionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user: "U123",
        ts: "1234567890.123456",
        team: "T123",
        slackEventId: "Ev123",
      }),
    );
  });

  it("schedules valid Slack message events with normalized routing fields", async () => {
    const files = [{ id: "F123", name: "trace.log" }];
    const edited = { user: "UEDITOR", ts: "1234567890.222222" };
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvMessage123",
      team_id: "T123",
      event: {
        type: "message",
        user: "U123",
        text: "follow-up from Slack",
        ts: "1234567890.123456",
        channel: "C123",
        thread_ts: "1234567890.000001",
        subtype: "file_share",
        hidden: false,
        files,
        edited,
      },
    });

    const response = await POST(makeSignedRequest(body));

    expect(response.status).toBe(200);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    await mocks.waitUntil.mock.calls[0]?.[0];
    expect(mocks.handleSlackMessageEvent).toHaveBeenCalledWith({
      event: {
        type: "message",
        user: "U123",
        text: "follow-up from Slack",
        ts: "1234567890.123456",
        channel: "C123",
        thread_ts: "1234567890.000001",
        team: "T123",
        bot_id: undefined,
        subtype: "file_share",
        hidden: false,
        files,
        edited,
      },
      slackEventId: "EvMessage123",
    });
  });

  it("preserves retry timestamps and binds retries to the Slack actor", async () => {
    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      team: { id: "T123" },
      actions: [
        {
          action_id: "retry_task_creation",
          value: JSON.stringify({
            user: "U123",
            team: "T123",
            channel: "C123",
            text: "<@B123> fix this",
            ts: "1234567890.123456",
            thread_ts: "1234567890.123456",
          }),
        },
      ],
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();

    const response = await POST(makeSignedRequest(body));

    expect(response.status).toBe(200);
    expect(mocks.handleAppMentionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user: "U123",
        team: "T123",
        ts: "1234567890.123456",
      }),
    );
  });

  it("accepts legacy retry payloads that only stored thread_ts", async () => {
    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      team: { id: "T123" },
      actions: [
        {
          action_id: "retry_task_creation",
          value: JSON.stringify({
            user: "U123",
            team: "T123",
            channel: "C123",
            text: "<@B123> fix this",
            thread_ts: "1234567890.123456",
          }),
        },
      ],
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();

    const response = await POST(makeSignedRequest(body));

    expect(response.status).toBe(200);
    expect(mocks.handleAppMentionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user: "U123",
        team: "T123",
        ts: "1234567890.123456",
        thread_ts: "1234567890.123456",
      }),
    );
  });

  it("ignores retry clicks from a different Slack actor", async () => {
    const payload = {
      type: "block_actions",
      user: { id: "UOTHER" },
      team: { id: "T123" },
      actions: [
        {
          action_id: "retry_task_creation",
          value: JSON.stringify({
            user: "U123",
            team: "T123",
            channel: "C123",
            text: "<@B123> fix this",
            ts: "1234567890.123456",
          }),
        },
      ],
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();

    const response = await POST(makeSignedRequest(body));

    expect(response.status).toBe(200);
    expect(mocks.handleAppMentionEvent).not.toHaveBeenCalled();
  });
});
