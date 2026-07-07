import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "./transcript-store";

const RUN = "run-1";

function textStart(messageId: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  } as BaseEvent;
}

function textContent(messageId: string, delta: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
  } as BaseEvent;
}

describe("TranscriptStore", () => {
  it("notifies subscribers when state changes", () => {
    const store = new TranscriptStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyEvent(textStart("m1"), RUN);
    store.applyEvent(textContent("m1", "hi"), RUN);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify for a no-op event", () => {
    const store = new TranscriptStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyEvent({ type: EventType.STEP_STARTED } as BaseEvent, RUN);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps a stable state reference across a no-op", () => {
    const store = new TranscriptStore();
    store.applyEvent(textStart("m1"), RUN);
    const before = store.getState();
    store.applyEvent({ type: EventType.STEP_STARTED } as BaseEvent, RUN);
    expect(store.getState()).toBe(before);
  });

  it("exposes per-item version counters", () => {
    const store = new TranscriptStore();
    store.applyEvent(textStart("m1"), RUN);
    const v1 = store.getItemVersion("text:m1");
    store.applyEvent(textContent("m1", "hi"), RUN);
    expect(store.getItemVersion("text:m1")).toBeGreaterThan(v1);
    expect(store.getRevision()).toBe(2);
  });

  it("stops notifying after unsubscribe", () => {
    const store = new TranscriptStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.applyEvent(textStart("m1"), RUN);
    expect(listener).not.toHaveBeenCalled();
  });

  it("resets to an empty transcript", () => {
    const store = new TranscriptStore();
    store.applyEvent(textStart("m1"), RUN);
    store.reset();
    expect(store.getItems()).toHaveLength(0);
  });
});
