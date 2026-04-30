import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const sessionMocks = vi.hoisted(() => ({
  getSessionOrNull: vi.fn(),
}));

const adapterMocks = vi.hoisted(() => ({
  cancelThreadFromAgUiInput: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
  getSessionOrNull: sessionMocks.getSessionOrNull,
}));

vi.mock("@/server-lib/cancel-from-ag-ui", () => ({
  cancelThreadFromAgUiInput: adapterMocks.cancelThreadFromAgUiInput,
}));

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(threadId: string) {
  return { params: Promise.resolve({ threadId }) };
}

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(url, { method: "POST", headers });
}

const BASE_URL =
  "http://localhost/api/ag-ui/thread-1/cancel?threadChatId=chat-1";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/ag-ui/[threadId]/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated session
    sessionMocks.getSessionOrNull.mockResolvedValue({
      user: { id: "user-1" },
    });
    // Default: adapter returns ok
    adapterMocks.cancelThreadFromAgUiInput.mockResolvedValue({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("returns 401 when session is missing", async () => {
      sessionMocks.getSessionOrNull.mockResolvedValue(null);

      const response = await POST(
        makeRequest(BASE_URL),
        makeContext("thread-1"),
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("does NOT call adapter when unauthenticated", async () => {
      sessionMocks.getSessionOrNull.mockResolvedValue(null);

      await POST(makeRequest(BASE_URL), makeContext("thread-1"));

      expect(adapterMocks.cancelThreadFromAgUiInput).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe("input validation", () => {
    it("returns 400 when threadChatId is missing", async () => {
      const url = "http://localhost/api/ag-ui/thread-1/cancel";

      const response = await POST(makeRequest(url), makeContext("thread-1"));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: "Missing threadChatId" });
    });

    it("does NOT call adapter when threadChatId is missing", async () => {
      const url = "http://localhost/api/ag-ui/thread-1/cancel";

      await POST(makeRequest(url), makeContext("thread-1"));

      expect(adapterMocks.cancelThreadFromAgUiInput).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Successful cancel
  // -------------------------------------------------------------------------

  describe("successful cancel", () => {
    it("returns 200 with { ok: true } on success", async () => {
      const response = await POST(
        makeRequest(BASE_URL),
        makeContext("thread-1"),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
    });

    it("calls the adapter with the correct arguments (non-replay)", async () => {
      await POST(makeRequest(BASE_URL), makeContext("thread-1"));

      expect(adapterMocks.cancelThreadFromAgUiInput).toHaveBeenCalledWith({
        threadId: "thread-1",
        threadChatId: "chat-1",
        userId: "user-1",
        isReplayMode: false,
      });
    });

    it("resolves threadId from the dynamic route segment", async () => {
      const url =
        "http://localhost/api/ag-ui/my-thread-id/cancel?threadChatId=my-chat-id";

      await POST(makeRequest(url), makeContext("my-thread-id"));

      expect(adapterMocks.cancelThreadFromAgUiInput).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "my-thread-id",
          threadChatId: "my-chat-id",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Replay mode
  // -------------------------------------------------------------------------

  describe("replay mode", () => {
    it("passes isReplayMode: true to adapter when X-Terragon-Test-Replay header is set", async () => {
      adapterMocks.cancelThreadFromAgUiInput.mockResolvedValue({
        skipped: "replay-mode",
      });

      await POST(
        makeRequest(BASE_URL, { "X-Terragon-Test-Replay": "1" }),
        makeContext("thread-1"),
      );

      expect(adapterMocks.cancelThreadFromAgUiInput).toHaveBeenCalledWith(
        expect.objectContaining({ isReplayMode: true }),
      );
    });

    it("returns 200 with { skipped: 'replay-mode' } when adapter skips", async () => {
      adapterMocks.cancelThreadFromAgUiInput.mockResolvedValue({
        skipped: "replay-mode",
      });

      const response = await POST(
        makeRequest(BASE_URL, { "X-Terragon-Test-Replay": "1" }),
        makeContext("thread-1"),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ skipped: "replay-mode" });
    });

    it("passes isReplayMode: false when header is absent", async () => {
      await POST(makeRequest(BASE_URL), makeContext("thread-1"));

      expect(adapterMocks.cancelThreadFromAgUiInput).toHaveBeenCalledWith(
        expect.objectContaining({ isReplayMode: false }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Authorization errors from adapter
  // -------------------------------------------------------------------------

  describe("adapter authorization errors", () => {
    it("returns 403 when adapter returns unauthorized error", async () => {
      adapterMocks.cancelThreadFromAgUiInput.mockResolvedValue({
        error: { kind: "unauthorized" },
      });

      const response = await POST(
        makeRequest(BASE_URL),
        makeContext("thread-1"),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({ error: "Forbidden" });
    });

    it("returns 403 when adapter returns thread-not-found error", async () => {
      adapterMocks.cancelThreadFromAgUiInput.mockResolvedValue({
        error: { kind: "thread-not-found" },
      });

      const response = await POST(
        makeRequest(BASE_URL),
        makeContext("thread-1"),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({ error: "Forbidden" });
    });
  });
});
