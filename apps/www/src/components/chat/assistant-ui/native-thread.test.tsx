/* @vitest-environment jsdom */

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NativeThread } from "./native-thread";

// jsdom lacks these browser APIs that assistant-ui's Viewport primitive uses.
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const SEED_MESSAGES: ThreadMessageLike[] = [
  { role: "user", content: "show me the files" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I should list the directory" },
      { type: "text", text: "Here are the files." },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "Bash",
        argsText: '{"command":"ls"}',
        result: "file.txt",
      },
    ],
  },
];

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: SEED_MESSAGES,
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(NativeThread),
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("NativeThread", () => {
  it("renders user text, assistant text, reasoning, and tool calls from the runtime", () => {
    mount();
    const text = container?.textContent ?? "";

    // User + assistant text (streamdown markdown slot).
    expect(text).toContain("show me the files");
    expect(text).toContain("Here are the files.");

    // Reasoning renders under a collapsible "Thinking" affordance.
    expect(text).toContain("Thinking");
    expect(text).toContain("I should list the directory");

    // Every tool renders through the single generic tool card.
    expect(text).toContain("Bash");
    expect(text).toContain("file.txt");
  });
});
