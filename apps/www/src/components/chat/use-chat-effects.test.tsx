/* @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollToHashMessageOnce } from "./use-chat-effects";

function ScrollHarness({
  messages,
  resetKey,
}: {
  messages: ReadonlyArray<unknown>;
  resetKey: string;
}) {
  useScrollToHashMessageOnce({ messages, resetKey });
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let scrollIntoView: ReturnType<typeof vi.fn>;

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function renderHarness(params: {
  messages: ReadonlyArray<unknown>;
  resetKey: string;
}) {
  act(() => {
    root!.render(createElement(ScrollHarness, params));
  });
}

describe("useScrollToHashMessageOnce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.location.hash = "#message-1";
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    document.body.innerHTML = '<div data-message-index="1"></div>';
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.location.hash = "";
  });

  it("scrolls once per thread/hash reset key", () => {
    mount(
      createElement(ScrollHarness, {
        messages: ["first", "second"],
        resetKey: "thread-1",
      }),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    renderHarness({
      messages: ["first", "second"],
      resetKey: "thread-1",
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    renderHarness({
      messages: ["first", "second"],
      resetKey: "thread-2",
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("cleans up the delayed scroll timeout on unmount", () => {
    mount(
      createElement(ScrollHarness, {
        messages: ["first", "second"],
        resetKey: "thread-1",
      }),
    );

    act(() => {
      root!.unmount();
      root = null;
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
