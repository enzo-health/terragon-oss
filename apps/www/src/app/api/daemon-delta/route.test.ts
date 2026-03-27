import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { appendTokenStreamEvents } from "@terragon/shared/model/token-stream-event";
import { publishDeltaBroadcast } from "@terragon/shared/broadcast-server";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn(),
}));

vi.mock("@terragon/shared/model/token-stream-event", () => ({
  appendTokenStreamEvents: vi.fn(),
}));

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishDeltaBroadcast: vi.fn(),
}));

describe("daemon-delta route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        sandboxId: "sandbox-1",
        agent: "claudeCode",
        transportMode: "acp",
        protocolVersion: 2,
        providers: ["anthropic"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    });
    vi.mocked(appendTokenStreamEvents).mockResolvedValue([]);
    vi.mocked(publishDeltaBroadcast).mockResolvedValue(undefined);
  });

  it("requires daemon run claims", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "key-1",
      claims: null,
    });

    const response = await POST(
      new Request("http://localhost/api/daemon-delta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-1",
          threadChatId: "chat-1",
          deltas: [
            {
              messageId: "m-1",
              partIndex: 0,
              deltaSeq: 1,
              kind: "text",
              text: "hello",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(appendTokenStreamEvents).not.toHaveBeenCalled();
  });

  it("persists deterministic idempotency keys and publishes in stream order", async () => {
    vi.mocked(appendTokenStreamEvents).mockResolvedValue([
      {
        id: "e-9",
        streamSeq: 9,
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        messageId: "m-1",
        partIndex: 0,
        partType: "text",
        text: "world",
        idempotencyKey: "k-9",
        createdAt: new Date(),
      },
      {
        id: "e-7",
        streamSeq: 7,
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        messageId: "m-1",
        partIndex: 0,
        partType: "text",
        text: "hello",
        idempotencyKey: "k-7",
        createdAt: new Date(),
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/daemon-delta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-1",
          threadChatId: "chat-1",
          deltas: [
            {
              messageId: "m-1",
              partIndex: 0,
              deltaSeq: 1,
              kind: "text",
              text: "hello",
            },
            {
              messageId: "m-1",
              partIndex: 0,
              deltaSeq: 2,
              kind: "text",
              text: "world",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(appendTokenStreamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            idempotencyKey: "chat-1:run-1:delta:m-1:0:1:0",
          }),
          expect.objectContaining({
            idempotencyKey: "chat-1:run-1:delta:m-1:0:2:1",
          }),
        ],
      }),
    );
    expect(publishDeltaBroadcast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deltaSeq: 7,
        deltaIdempotencyKey: "k-7",
        deltaKind: "text",
      }),
    );
    expect(publishDeltaBroadcast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deltaSeq: 9, deltaIdempotencyKey: "k-9" }),
    );
  });
});
