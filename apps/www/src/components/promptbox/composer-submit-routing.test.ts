import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type ComposerSubmitCommand,
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

describe("routeComposerSubmit", () => {
  it("submits idle messages through the fallback command", async () => {
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("ship it"),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: queue,
    });

    expect(outcome).toEqual({ type: "fallback-submitted", reason: "default" });
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({ clientSubmissionId: "submission-1" }),
    );
    expect(queue).not.toHaveBeenCalled();
  });

  it("falls back for draft submit intents", async () => {
    const fallback = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      saveAsDraft: true,
      userMessage: richTextMessage("save"),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "draft-or-schedule",
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back for scheduled submit intents", async () => {
    const fallback = vi.fn<ComposerSubmitCommand>();
    const scheduleAt = Date.now() + 60_000;

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      scheduleAt,
      userMessage: richTextMessage("schedule"),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "draft-or-schedule",
    });
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleAt }),
    );
  });

  it("queues active messages at the composer boundary", async () => {
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("queue it"),
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
    expect(fallback).not.toHaveBeenCalled();
  });

  it("submits through fallback when queueing is disabled while working", async () => {
    const fallback = vi.fn<ComposerSubmitCommand>();
    const queue = vi.fn<ComposerSubmitCommand>();

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("send anyway"),
      isAgentWorking: true,
      isQueueingEnabled: false,
      submitFallback: fallback,
      queueMessage: queue,
    });

    expect(outcome).toEqual({ type: "fallback-submitted", reason: "default" });
    expect(fallback).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
  });

  it("fires optimisticSubmit once before the fallback submit", async () => {
    const calls: string[] = [];
    const fallback = vi.fn<ComposerSubmitCommand>(async () => {
      calls.push("fallback");
    });
    const optimisticSubmit = vi.fn(() => {
      calls.push("optimistic");
    });

    const outcome = await routeComposerSubmit({
      ...submitArgs(),
      userMessage: richTextMessage("ship it"),
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: vi.fn(),
      optimisticSubmit,
    });

    expect(outcome).toEqual({ type: "fallback-submitted", reason: "default" });
    expect(optimisticSubmit).toHaveBeenCalledOnce();
    expect(optimisticSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ clientSubmissionId: "submission-1" }),
    );
    expect(calls).toEqual(["optimistic", "fallback"]);
  });

  it("fires optimisticSubmit once on the draft fallback route", async () => {
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
      isAgentWorking: false,
      isQueueingEnabled: true,
      submitFallback: fallback,
      queueMessage: vi.fn(),
      optimisticSubmit,
    });

    expect(outcome).toEqual({
      type: "fallback-submitted",
      reason: "draft-or-schedule",
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
