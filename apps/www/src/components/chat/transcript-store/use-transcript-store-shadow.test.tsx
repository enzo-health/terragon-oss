/* @vitest-environment jsdom */

import type { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectTranscriptState } from "./project-transcript";
import {
  isTranscriptStoreShadowEnabled,
  useTranscriptStoreShadow,
} from "./use-transcript-store-shadow";
import type { TranscriptStore } from "./transcript-store";

type EventCallback = (params: { event: BaseEvent }) => void;

class FakeAgent {
  private callback: EventCallback | null = null;

  subscribe(subscriber: { onEvent?: EventCallback }) {
    this.callback = subscriber.onEvent ?? null;
    return {
      unsubscribe: () => {
        this.callback = null;
      },
    };
  }

  emit(event: BaseEvent) {
    this.callback?.({ event });
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete process.env.NEXT_PUBLIC_TRANSCRIPT_STORE_SHADOW;
});

function renderShadow(agent: AbstractAgent | null): {
  current: TranscriptStore | null;
} {
  const ref: { current: TranscriptStore | null } = { current: null };
  function Probe() {
    ref.current = useTranscriptStoreShadow(agent);
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return ref;
}

describe("isTranscriptStoreShadowEnabled", () => {
  it("is off by default", () => {
    expect(isTranscriptStoreShadowEnabled()).toBe(false);
  });

  it("honors the public env flag", () => {
    process.env.NEXT_PUBLIC_TRANSCRIPT_STORE_SHADOW = "1";
    expect(isTranscriptStoreShadowEnabled()).toBe(true);
  });
});

describe("useTranscriptStoreShadow", () => {
  it("returns null when disabled", () => {
    const agent = new FakeAgent() as unknown as AbstractAgent;
    const ref = renderShadow(agent);
    expect(ref.current).toBeNull();
  });

  it("folds subscribed events and tracks runId when enabled", () => {
    process.env.NEXT_PUBLIC_TRANSCRIPT_STORE_SHADOW = "1";
    const agent = new FakeAgent();
    const ref = renderShadow(agent as unknown as AbstractAgent);
    const store = ref.current;
    expect(store).not.toBeNull();

    act(() => {
      agent.emit({
        type: EventType.RUN_STARTED,
        runId: "run-9",
        threadId: "t",
      } as BaseEvent);
      agent.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as BaseEvent);
      agent.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hi",
      } as BaseEvent);
    });

    const state = store!.getState();
    expect(state.currentRunId).toBe("run-9");
    expect(projectTranscriptState(state).assistantText.m1).toBe("hi");
    const textItem = state.items.find((item) => item.key === "text:m1");
    expect(textItem?.runId).toBe("run-9");
  });
});
