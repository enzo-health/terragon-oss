/* @vitest-environment jsdom */

import { type BaseEvent, EventType } from "@ag-ui/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../transcript-store";
import { TranscriptItems } from "./transcript-items";

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
});

function emit(store: TranscriptStore, event: Partial<BaseEvent>) {
  store.apply({ payload: event as BaseEvent, runId: "run-1" });
}

describe("TranscriptItems (fold → render)", () => {
  it("renders a streamed assistant message and a completed tool call", () => {
    const store = new TranscriptStore();
    act(() => {
      root.render(createElement(TranscriptItems, { store }));
    });

    act(() => {
      emit(store, { type: EventType.RUN_STARTED, runId: "run-1" });
      emit(store, {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      });
      emit(store, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Working on it",
      });
      emit(store, {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "Bash",
      });
      emit(store, {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "t1",
        content: "listing done",
      });
    });

    expect(container.textContent).toContain("Working on it");
    expect(container.textContent).toContain("Bash");
  });

  it("renders a rich diff part folded from a terragon.part custom event", () => {
    const store = new TranscriptStore();
    act(() => {
      root.render(createElement(TranscriptItems, { store }));
    });

    act(() => {
      emit(store, {
        type: EventType.CUSTOM,
        name: "terragon.part",
        value: {
          richKind: "diff",
          messageId: "m2",
          partIndex: 0,
          payload: {
            filePath: "src/x.ts",
            oldContent: "a\n",
            newContent: "b\n",
          },
        },
      });
    });

    expect(container.textContent).toContain("src/x.ts");
  });

  it("appends new streaming deltas into the existing message", () => {
    const store = new TranscriptStore();
    act(() => {
      root.render(createElement(TranscriptItems, { store }));
    });

    act(() => {
      emit(store, {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      });
      emit(store, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "part one ",
      });
    });
    expect(container.textContent).toContain("part one");

    act(() => {
      emit(store, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "part two",
      });
    });
    expect(container.textContent).toContain("part one part two");
  });
});
