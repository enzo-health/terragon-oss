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
      // A rich Terragon data part: pure-native NativeThread renders nothing
      // for it (the bespoke renderers are removed) and must not crash.
      {
        type: "data",
        name: "terragon.terminal",
        data: { type: "terminal", terminalId: "term-1" },
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("NativeThread", () => {
  it("renders text, reasoning, and tool calls through native assistant-ui primitives", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness));
    });
    const text = container?.textContent ?? "";

    expect(text).toContain("show me the files");
    expect(text).toContain("Here are the files.");
    expect(text).toContain("Thinking");
    expect(text).toContain("I should list the directory");
    expect(text).toContain("Bash");
    expect(text).toContain("file.txt");
  });
});
