/* @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  GroupedRunWithFailure,
  ReasoningOpenStreaming,
  StreamingText,
  ToolDone,
  ToolFailed,
  ToolRunning,
} from "./native-thread.stories";

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

let container: HTMLElement | null = null;
let root: Root | null = null;

function mount(story: () => React.ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(story));
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("native-thread stories", () => {
  it("StreamingText renders the partial response body", () => {
    const text = mount(StreamingText).textContent ?? "";
    expect(text).toContain("Streaming a partial response");
  });

  it("ReasoningOpenStreaming renders the Thinking label and body", () => {
    const text = mount(ReasoningOpenStreaming).textContent ?? "";
    expect(text).toContain("Thinking");
    expect(text).toContain("inspect the directory");
  });

  it("ToolRunning renders the tool name and a Running state", () => {
    const text = mount(ToolRunning).textContent ?? "";
    expect(text).toContain("Bash");
    expect(text).toContain("Running");
  });

  it("ToolFailed renders the tool name and a Failed state", () => {
    const text = mount(ToolFailed).textContent ?? "";
    expect(text).toContain("Read");
    expect(text).toContain("Failed");
  });

  it("ToolDone renders the tool name and a Done state", () => {
    const text = mount(ToolDone).textContent ?? "";
    expect(text).toContain("Read");
    expect(text).toContain("Done");
  });

  it("GroupedRunWithFailure collapses into a tool group flagged for attention", () => {
    const root = mount(GroupedRunWithFailure);
    const group = Array.from(root.querySelectorAll("details")).find((details) =>
      details.textContent?.includes("Tool calls (3)"),
    );
    if (!group) {
      throw new Error(
        "expected a grouped tool-call disclosure for three calls",
      );
    }
    expect(group.textContent).toContain("Needs attention");
    expect(group.open).toBe(false);
  });
});
