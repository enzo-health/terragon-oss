import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import { describe, expect, it, vi } from "vitest";
import { dbUserPartsToAssistantContent } from "@/lib/user-message-content";
import {
  type ComposerSubmitCommand,
  type ComposerSubmitRuntime,
  classifyComposerSubmitRoute,
  routeComposerSubmit,
} from "./composer-submit-routing";

const model = "claude-3-5-sonnet-20241022" as AIModel;
const selectedModels = {} as SelectedAIModels;

function richTextMessage(text: string): DBUserMessage {
  return {
    type: "user",
    model,
    parts: [{ type: "rich-text", nodes: [{ type: "text", text }] }],
    permissionMode: "allowAll",
  };
}

function imageMessage(): DBUserMessage {
  return {
    type: "user",
    model,
    parts: [
      {
        type: "image",
        mime_type: "image/png",
        image_url: "https://example.com/image.png",
      },
    ],
  };
}

function messageWithPdf(): DBUserMessage {
  return {
    ...richTextMessage("read this"),
    parts: [
      ...richTextMessage("read this").parts,
      {
        type: "pdf",
        mime_type: "application/pdf",
        pdf_url: "https://example.com/file.pdf",
        filename: "file.pdf",
      },
    ],
  };
}

function submitArgs() {
  return {
    selectedModels,
    repoFullName: "terragon/oss",
    branchName: "main",
    saveAsDraft: false,
    scheduleAt: null,
    clientSubmissionId: "submission-1",
  };
}

function runtime(append: ComposerSubmitRuntime["append"]) {
  return { append } satisfies ComposerSubmitRuntime;
}

describe("dbUserPartsToAssistantContent", () => {
  it("converts text, rich text, mentions, and images to assistant-ui content", () => {
    const content = dbUserPartsToAssistantContent([
      { type: "text", text: "plain" },
      { type: "rich-text", nodes: [{ type: "text", text: "hello" }] },
      { type: "rich-text", nodes: [{ type: "mention", text: "src/app.ts" }] },
      {
        type: "image",
        mime_type: "image/png",
        image_url: "https://example.com/image.png",
      },
    ]);

    expect(content).toEqual([
      { type: "text", text: "plain" },
      { type: "text", text: "hello" },
      { type: "text", text: "@src/app.ts" },
      { type: "image", image: "https://example.com/image.png" },
    ]);
  });
});

describe("classifyComposerSubmitRoute", () => {
  it("routes text-only messages through runtime append", () => {
    const routing = classifyComposerSubmitRoute(richTextMessage("ship it"));

    expect(routing.type).toBe("runtime");
  });

  it("routes image messages through runtime append", () => {
    const routing = classifyComposerSubmitRoute(imageMessage());

    expect(routing).toEqual({
      type: "runtime",
      content: [{ type: "image", image: "https://example.com/image.png" }],
    });
  });

  it("routes mixed supported and unsupported attachment messages to fallback", () => {
    const routing = classifyComposerSubmitRoute(messageWithPdf());

    expect(routing.type).toBe("unsupported-parts");
  });

  it("routes empty runtime content as a validation no-op", () => {
    const routing = classifyComposerSubmitRoute({
      type: "user",
      model,
      parts: [{ type: "rich-text", nodes: [] }],
    });

    expect(routing.type).toBe("empty-runtime-content");
  });
});

describe("routeComposerSubmit", () => {
  it("starts runtime append for idle supported messages", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("ship it"),
      threadRuntime: runtime(append),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: queue,
    });

    expect(outcome).toEqual({ type: "runtime-append-started" });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: {
          custom: {
            terragon: expect.objectContaining({
              clientSubmissionId: "submission-1",
              intent: "append",
            }),
          },
        },
      }),
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it("falls back for draft or scheduled submit intents while runtime is present", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      saveAsDraft: true,
      userMessage: richTextMessage("save"),
      threadRuntime: runtime(append),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "unsupported-intent",
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it("falls back for scheduled submit intents while runtime is present", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();
    const scheduleAt = Date.now() + 60_000;

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      scheduleAt,
      userMessage: richTextMessage("schedule"),
      threadRuntime: runtime(append),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "unsupported-intent",
    });
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleAt }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("queues active messages at the composer boundary", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("queue it"),
      threadRuntime: runtime(append),
      isAgentWorking: true,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: queue,
    });

    expect(outcome).toEqual({ type: "queued-locally" });
    expect(queue).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ clientSubmissionId: "submission-1" }),
    );
    expect(append).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("queues active unsupported attachment messages without partial runtime append", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();
    const userMessage = messageWithPdf();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage,
      threadRuntime: runtime(append),
      isAgentWorking: true,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: queue,
    });

    expect(outcome).toEqual({ type: "queued-locally" });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage }),
    );
    expect(append).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for unsupported mixed attachment messages instead of partially appending", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: messageWithPdf(),
      threadRuntime: runtime(append),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "unsupported-parts",
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it("starts runtime append for image messages", async () => {
    const append = vi.fn<ComposerSubmitRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: imageMessage(),
      threadRuntime: runtime(append),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({ type: "runtime-append-started" });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "image", image: "https://example.com/image.png" }],
      }),
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses fallback submit when no runtime exists", async () => {
    const fallback = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("create thread"),
      threadRuntime: null,
      isAgentWorking: false,
      isQueueingEnabled: false,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "no-runtime",
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("fires optimisticSubmit once before runtime append for an idle supported message", async () => {
    const calls: string[] = [];
    const append = vi.fn<ComposerSubmitRuntime["append"]>(() => {
      calls.push("append");
    });
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();
    const optimisticSubmit = vi.fn(() => {
      calls.push("optimistic");
    });

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("ship it"),
      threadRuntime: runtime(append),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: queue,
      optimisticSubmit,
    });

    expect(outcome).toEqual({ type: "runtime-append-started" });
    expect(optimisticSubmit).toHaveBeenCalledOnce();
    expect(optimisticSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ clientSubmissionId: "submission-1" }),
    );
    expect(calls).toEqual(["optimistic", "append"]);
  });

  it("fires optimisticSubmit once before the unsupported-parts fallback route", async () => {
    const calls: string[] = [];
    const fallback = vi.fn<ComposerSubmitCommand>(async () => {
      calls.push("fallback");
    });
    const optimisticSubmit = vi.fn(() => {
      calls.push("optimistic");
    });

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: messageWithPdf(),
      threadRuntime: runtime(vi.fn()),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      optimisticSubmit,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "unsupported-parts",
    });
    expect(optimisticSubmit).toHaveBeenCalledOnce();
    expect(calls).toEqual(["optimistic", "fallback"]);
  });

  it("fires optimisticSubmit once on the draft fallback route while idle", async () => {
    const calls: string[] = [];
    const fallback = vi.fn<ComposerSubmitCommand>(async () => {
      calls.push("fallback");
    });
    const optimisticSubmit = vi.fn(() => {
      calls.push("optimistic");
    });

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      saveAsDraft: true,
      userMessage: richTextMessage("save"),
      threadRuntime: runtime(vi.fn()),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: vi.fn(),
      optimisticSubmit,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "unsupported-intent",
    });
    expect(optimisticSubmit).toHaveBeenCalledOnce();
    expect(calls).toEqual(["optimistic", "fallback"]);
  });

  it("does NOT fire optimisticSubmit on the queue route", async () => {
    const optimisticSubmit = vi.fn();
    const queue = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("queue it"),
      threadRuntime: runtime(vi.fn()),
      isAgentWorking: true,
      isQueueingEnabled: true,
      submitFallback: vi.fn(),
      queueMessage: queue,
      optimisticSubmit,
    });

    expect(outcome).toEqual({ type: "queued-locally" });
    expect(queue).toHaveBeenCalledOnce();
    expect(optimisticSubmit).not.toHaveBeenCalled();
  });
});
