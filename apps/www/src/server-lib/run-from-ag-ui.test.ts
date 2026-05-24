import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentInput } from "@ag-ui/core";
import type { DBUserMessage } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const threadMocks = vi.hoisted(() => ({
  getThreadChat: vi.fn(),
}));

const agentEventMocks = vi.hoisted(() => ({
  getLatestRunIdForThreadChat: vi.fn(),
}));

const followUpMocks = vi.hoisted(() => ({
  followUpInternal: vi.fn(),
}));

const redisMocks = vi.hoisted(() => ({
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { label: "db" },
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: threadMocks.getThreadChat,
}));

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  getLatestRunIdForThreadChat: agentEventMocks.getLatestRunIdForThreadChat,
}));

vi.mock("@/server-lib/follow-up", () => ({
  followUpInternal: followUpMocks.followUpInternal,
}));

vi.mock("@/lib/redis", () => ({
  redis: redisMocks,
}));

import { runFollowUpFromAgUiInput } from "./run-from-ag-ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THREAD_CHAT_ROW = {
  id: "chat-1",
  status: "complete",
  userId: "user-1",
  threadId: "thread-1",
};

function makeBody(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "Hello",
      },
    ],
    state: null,
    ...overrides,
  } as RunAgentInput;
}

const BASE_ARGS = {
  threadId: "thread-1",
  threadChatId: "chat-1",
  userId: "user-1",
  body: makeBody(),
  isReplayMode: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runFollowUpFromAgUiInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path mocks
    threadMocks.getThreadChat.mockResolvedValue(THREAD_CHAT_ROW);
    redisMocks.set.mockResolvedValue("OK");
    redisMocks.del.mockResolvedValue(1);
    followUpMocks.followUpInternal.mockResolvedValue(undefined);
    agentEventMocks.getLatestRunIdForThreadChat.mockResolvedValue("run-xyz");
  });

  // -------------------------------------------------------------------------
  // Replay-mode bypass
  // -------------------------------------------------------------------------

  describe("replay-mode bypass", () => {
    it("returns { skipped: 'replay-mode' } immediately", async () => {
      const result = await runFollowUpFromAgUiInput({
        ...BASE_ARGS,
        isReplayMode: true,
      });

      expect(result).toEqual({ skipped: "replay-mode" });
    });

    it("does NOT call followUpInternal in replay mode", async () => {
      await runFollowUpFromAgUiInput({ ...BASE_ARGS, isReplayMode: true });

      expect(followUpMocks.followUpInternal).not.toHaveBeenCalled();
    });

    it("does NOT acquire the Redis lock in replay mode", async () => {
      await runFollowUpFromAgUiInput({ ...BASE_ARGS, isReplayMode: true });

      expect(redisMocks.set).not.toHaveBeenCalled();
      expect(redisMocks.del).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Ownership validation
  // -------------------------------------------------------------------------

  describe("ownership validation", () => {
    it("returns { error: { kind: 'unauthorized' } } when getThreadChat returns undefined", async () => {
      threadMocks.getThreadChat.mockResolvedValue(undefined);

      const result = await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ error: { kind: "unauthorized" } });
    });

    it("does NOT acquire the lock when ownership check fails", async () => {
      threadMocks.getThreadChat.mockResolvedValue(undefined);

      await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(redisMocks.set).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Lock collision
  // -------------------------------------------------------------------------

  describe("lock collision", () => {
    it("returns { error: { kind: 'lock-held' } } when SET NX returns null", async () => {
      redisMocks.set.mockResolvedValue(null);

      const result = await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ error: { kind: "lock-held" } });
    });

    it("does NOT call followUpInternal when the lock is held", async () => {
      redisMocks.set.mockResolvedValue(null);

      await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(followUpMocks.followUpInternal).not.toHaveBeenCalled();
    });

    it("uses the correct Redis key for the lock", async () => {
      redisMocks.set.mockResolvedValue("OK");

      await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(redisMocks.set).toHaveBeenCalledWith("lock:run:chat-1", "1", {
        nx: true,
        ex: 5,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Successful path
  // -------------------------------------------------------------------------

  describe("successful dispatch", () => {
    it("calls followUpInternal with the correct arguments", async () => {
      await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith({
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        message: expect.objectContaining<Partial<DBUserMessage>>({
          type: "user",
          parts: [
            {
              type: "rich-text",
              nodes: [{ type: "text", text: "Hello" }],
            },
          ],
        }),
        source: "www",
      });
    });

    it("returns { runId } from getLatestRunIdForThreadChat", async () => {
      agentEventMocks.getLatestRunIdForThreadChat.mockResolvedValue("run-abc");

      const result = await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ runId: "run-abc" });
    });

    it("returns { runId: '' } when getLatestRunIdForThreadChat returns null (dispatch not yet written)", async () => {
      agentEventMocks.getLatestRunIdForThreadChat.mockResolvedValue(null);

      const result = await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ runId: "" });
    });

    it("releases the Redis lock in the finally block after success", async () => {
      await runFollowUpFromAgUiInput(BASE_ARGS);

      expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
    });

    it("releases the Redis lock even when followUpInternal throws", async () => {
      followUpMocks.followUpInternal.mockRejectedValue(
        new Error("dispatch error"),
      );

      await expect(runFollowUpFromAgUiInput(BASE_ARGS)).rejects.toThrow(
        "dispatch error",
      );

      expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
    });
  });

  // -------------------------------------------------------------------------
  // selectedModel metadata forwarding
  // -------------------------------------------------------------------------

  describe("metadata extraction", () => {
    it("forwards selectedModel from compatibility forwardedProps.terragon", async () => {
      const body = makeBody({
        forwardedProps: {
          terragon: { selectedModel: "sonnet" },
        },
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "sonnet",
          }),
        }),
      );
    });

    it("sets model to null when selectedModel is not a canonical AIModel", async () => {
      const body = makeBody({
        forwardedProps: {
          runConfig: {
            terragon: { selectedModel: "not-a-real-model" },
          },
        },
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ model: null }),
        }),
      );
    });

    it("sets model to null when forwardedProps is absent", async () => {
      const body = makeBody({ forwardedProps: undefined });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ model: null }),
        }),
      );
    });

    it("forwards permissionMode 'plan' from forwardedProps.terragon", async () => {
      const body = makeBody({
        forwardedProps: { terragon: { permissionMode: "plan" } },
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ permissionMode: "plan" }),
        }),
      );
    });

    it("omits permissionMode when value is unrecognized", async () => {
      const body = makeBody({
        forwardedProps: { terragon: { permissionMode: "bogus" } },
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.not.objectContaining({
            permissionMode: expect.anything(),
          }),
        }),
      );
    });

    it("reads metadata from forwardedProps.runConfig.terragon (assistant-ui runtime layout)", async () => {
      // useThreadRuntime().append({ runConfig: { custom: { terragon: ... } } })
      // gets wrapped by @assistant-ui/react into forwardedProps.runConfig.terragon.
      // The adapter must accept this layout in addition to the flat one.
      const body = makeBody({
        forwardedProps: {
          runConfig: {
            terragon: {
              selectedModel: "sonnet",
              permissionMode: "plan",
            },
          },
        },
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "sonnet",
            permissionMode: "plan",
          }),
        }),
      );
    });

    it("prefers forwardedProps.runConfig.terragon over forwardedProps.terragon when both are present", async () => {
      const body = makeBody({
        forwardedProps: {
          runConfig: {
            terragon: { selectedModel: "sonnet" },
          },
          terragon: { selectedModel: "opus" },
        },
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "sonnet",
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // AG-UI image attachment → DBImagePart roundtrip
  // -------------------------------------------------------------------------

  describe("image content conversion", () => {
    it("converts a URL-source image InputContent to a DBImagePart", async () => {
      const body = makeBody({
        messages: [
          {
            id: "msg-img",
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  value: "https://example.com/photo.png",
                  mimeType: "image/png",
                },
              },
            ],
          },
        ],
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              {
                type: "image",
                image_url: "https://example.com/photo.png",
                mime_type: "image/png",
              },
            ],
          }),
        }),
      );
    });

    it("converts a data-source image InputContent to a base64 data-URL DBImagePart", async () => {
      const body = makeBody({
        messages: [
          {
            id: "msg-img",
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "data",
                  value: "iVBORw0KGgo=",
                  mimeType: "image/png",
                },
              },
            ],
          },
        ],
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              {
                type: "image",
                image_url: "data:image/png;base64,iVBORw0KGgo=",
                mime_type: "image/png",
              },
            ],
          }),
        }),
      );
    });

    it("converts mixed text + image content correctly", async () => {
      const body = makeBody({
        messages: [
          {
            id: "msg-mixed",
            role: "user",
            content: [
              { type: "text", text: "Look at this:" },
              {
                type: "image",
                source: {
                  type: "url",
                  value: "https://example.com/shot.jpg",
                  mimeType: "image/jpeg",
                },
              },
            ],
          },
        ],
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              {
                type: "rich-text",
                nodes: [{ type: "text", text: "Look at this:" }],
              },
              {
                type: "image",
                image_url: "https://example.com/shot.jpg",
                mime_type: "image/jpeg",
              },
            ],
          }),
        }),
      );
    });

    it("uses image/jpeg as fallback mime_type when mimeType is absent on URL source", async () => {
      const body = makeBody({
        messages: [
          {
            id: "msg-img",
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  value: "https://example.com/photo",
                  // mimeType intentionally omitted
                },
              },
            ],
          },
        ],
      });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(followUpMocks.followUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              {
                type: "image",
                image_url: "https://example.com/photo",
                mime_type: "image/jpeg",
              },
            ],
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Invalid input
  // -------------------------------------------------------------------------

  describe("invalid input", () => {
    it("returns { error: { kind: 'invalid-input' } } when body.messages has no user message", async () => {
      const body = makeBody({
        messages: [
          {
            id: "sys-1",
            role: "system",
            content: "You are an assistant",
          },
        ],
      });

      const result = await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(result).toEqual({
        error: { kind: "invalid-input", reason: expect.any(String) },
      });
    });

    it("releases the lock even when input is invalid", async () => {
      const body = makeBody({ messages: [] });

      await runFollowUpFromAgUiInput({ ...BASE_ARGS, body });

      expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
    });
  });
});
