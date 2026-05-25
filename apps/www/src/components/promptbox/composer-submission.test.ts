import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import { describe, expect, it, vi } from "vitest";
import {
  dbPartsToAssistantUiContent,
  getComposerRuntimeRouting,
  submitComposerMessage,
  type ComposerSubmissionCommand,
  type ComposerSubmissionRuntime,
} from "./composer-submission";

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
  };
}

function runtime(append: ComposerSubmissionRuntime["append"]) {
  return { append } satisfies ComposerSubmissionRuntime;
}

describe("dbPartsToAssistantUiContent", () => {
  it("converts text, rich text, mentions, and images to assistant-ui content", () => {
    const content = dbPartsToAssistantUiContent([
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

describe("getComposerRuntimeRouting", () => {
  it("routes text-only messages through runtime append", () => {
    const routing = getComposerRuntimeRouting(richTextMessage("ship it"));

    expect(routing.type).toBe("runtime");
  });

  it("routes mixed supported and unsupported attachment messages to fallback", () => {
    const routing = getComposerRuntimeRouting(messageWithPdf());

    expect(routing.type).toBe("unsupported-parts");
  });

  it("routes empty runtime content as a validation no-op", () => {
    const routing = getComposerRuntimeRouting({
      type: "user",
      model,
      parts: [{ type: "rich-text", nodes: [] }],
    });

    expect(routing.type).toBe("empty-runtime-content");
  });
});

describe("submitComposerMessage", () => {
  it("starts runtime append for idle supported messages", async () => {
    const append = vi.fn<ComposerSubmissionRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmissionCommand>();
    const queue = vi.fn<ComposerSubmissionCommand>();

    const outcome = await submitComposerMessage({
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
              clientSubmissionId: expect.any(String),
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
    const append = vi.fn<ComposerSubmissionRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmissionCommand>();

    const outcome = await submitComposerMessage({
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

  it("queues active messages at the composer boundary", async () => {
    const append = vi.fn<ComposerSubmissionRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmissionCommand>();
    const queue = vi.fn<ComposerSubmissionCommand>();

    const outcome = await submitComposerMessage({
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
    expect(append).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for unsupported mixed attachment messages instead of partially appending", async () => {
    const append = vi.fn<ComposerSubmissionRuntime["append"]>();
    const fallback = vi.fn<ComposerSubmissionCommand>();

    const outcome = await submitComposerMessage({
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

  it("uses fallback submit when no runtime exists", async () => {
    const fallback = vi.fn<ComposerSubmissionCommand>();

    const outcome = await submitComposerMessage({
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
});
