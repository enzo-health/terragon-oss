import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@terragon/env/pkg-shared", () => ({
  env: {
    INTERNAL_SHARED_SECRET: "test-secret",
  },
}));

vi.mock("@terragon/env/next-public", () => ({
  publicBroadcastUrl: vi.fn(),
}));

import { publicBroadcastUrl } from "@terragon/env/next-public";
import { publishBroadcastUserMessage } from "./broadcast-server";

describe("publishBroadcastUserMessage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("publishes over http when the public broadcast URL uses ws", async () => {
    vi.mocked(publicBroadcastUrl).mockReturnValue("ws://localhost:1999");
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await publishBroadcastUserMessage({
      type: "user",
      id: "user-123",
      data: {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1999/parties/main/user:user-123",
      expect.objectContaining({
        method: "POST",
        headers: {
          "X-Terragon-Secret": "test-secret",
        },
      }),
    );
  });

  it("publishes over https when the public broadcast URL uses wss", async () => {
    vi.mocked(publicBroadcastUrl).mockReturnValue(
      "wss://broadcast.example.com",
    );
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await publishBroadcastUserMessage({
      type: "user",
      id: "user-123",
      data: {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://broadcast.example.com/parties/main/user:user-123",
      expect.any(Object),
    );
  });
});
