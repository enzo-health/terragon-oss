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

  it("ToolRunning renders the tool name and a running state", () => {
    const root = mount(ToolRunning);
    const tool = root.querySelector("[data-slot=tool]");
    expect(tool?.getAttribute("data-state")).toBe("running");
    expect(root.querySelector("[data-slot=tool-name]")?.textContent).toContain(
      "Bash",
    );
  });

  it("ToolFailed renders the tool name and an error state", () => {
    const root = mount(ToolFailed);
    const tool = root.querySelector("[data-slot=tool]");
    expect(tool?.getAttribute("data-state")).toBe("error");
    expect(root.querySelector("[data-slot=tool-name]")?.textContent).toContain(
      "Read",
    );
  });

  it("ToolDone renders the tool name and a success state", () => {
    const root = mount(ToolDone);
    const tool = root.querySelector("[data-slot=tool]");
    expect(tool?.getAttribute("data-state")).toBe("success");
    expect(root.querySelector("[data-slot=tool-name]")?.textContent).toContain(
      "Read",
    );
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
