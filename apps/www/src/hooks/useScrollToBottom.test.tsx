/* @vitest-environment jsdom */

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollToBottom } from "./useScrollToBottom";

type ResizeCallback = ResizeObserverCallback;

let container: HTMLDivElement;
let root: Root;
let scrollContainer: HTMLDivElement | null = null;
let forceScrollToBottom: ((behavior?: ScrollBehavior) => void) | null = null;
let scrollHeightValue = 1000;
let clientHeightValue = 500;
let resizeCallback: ResizeCallback | null = null;
let resizeCallbacks: ResizeCallback[] = [];
let rafQueue: FrameRequestCallback[] = [];
let navigationType = "navigate";
let initialScrollTop: number | null = null;
let scrollHeightReadCount = 0;
let clientHeightReadCount = 0;

class TestResizeObserver {
  private callback: ResizeCallback;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    resizeCallbacks.push(callback);
    resizeCallback = callback;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    if (resizeCallback === this.callback) {
      resizeCallback = null;
    }
  }
}

function flushRaf(): void {
  const callbacks = rafQueue;
  rafQueue = [];
  callbacks.forEach((callback) => callback(performance.now()));
}

function defineScrollMetrics(element: HTMLElement): void {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => {
      scrollHeightReadCount += 1;
      return scrollHeightValue;
    },
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => {
      clientHeightReadCount += 1;
      return clientHeightValue;
    },
  });
}

function triggerResize(): void {
  if (!resizeCallback) {
    throw new Error("expected ResizeObserver callback");
  }
  resizeCallback([], {} as ResizeObserver);
}

function ThreadHarness(): React.ReactElement {
  const observedRef = useRef<HTMLDivElement | null>(null);
  const { messagesEndRef, forceScrollToBottom: forceScrollToBottomFromHook } =
    useScrollToBottom({ observedRef });
  forceScrollToBottom = forceScrollToBottomFromHook;

  return (
    <div
      data-slot="scroll-area-viewport"
      ref={(node) => {
        scrollContainer = node;
        if (node) {
          defineScrollMetrics(node);
          if (initialScrollTop !== null) {
            node.scrollTop = initialScrollTop;
          }
        }
      }}
    >
      <div ref={observedRef}>
        <div data-testid="messages-end" ref={messagesEndRef} />
      </div>
    </div>
  );
}

function mountHarness(): void {
  act(() => {
    root.render(createElement(ThreadHarness));
  });
}

function flushInitialScroll(): void {
  act(() => {
    flushRaf();
  });
}

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      rafQueue[id - 1] = () => undefined;
    }),
  );
  vi.spyOn(window.performance, "getEntriesByType").mockImplementation(
    (type: string) =>
      type === "navigation"
        ? ([{ type: navigationType }] as unknown as PerformanceEntry[])
        : [],
  );
  scrollHeightValue = 1000;
  clientHeightValue = 500;
  navigationType = "navigate";
  initialScrollTop = null;
  window.history.replaceState(null, "", "/");
  resizeCallback = null;
  resizeCallbacks = [];
  rafQueue = [];
  scrollHeightReadCount = 0;
  clientHeightReadCount = 0;
  scrollContainer = null;
  forceScrollToBottom = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useScrollToBottom", () => {
  it("pins normal initial mounts before waiting for animation frames", () => {
    mountHarness();

    expect(scrollContainer?.scrollTop).toBe(1000);
    expect(rafQueue).toHaveLength(0);
  });

  it("preserves hash navigation on initial mount", () => {
    window.location.hash = "#message-1";
    mountHarness();

    expect(scrollContainer?.scrollTop).toBe(0);

    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(0);
  });

  it("preserves back-forward restored position on initial mount", () => {
    navigationType = "back_forward";
    initialScrollTop = 125;
    mountHarness();

    expect(scrollContainer?.scrollTop).toBe(125);

    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(125);
  });

  it("preserves restored scrollTop that exists before layout effects", () => {
    initialScrollTop = 160;
    mountHarness();

    expect(scrollContainer?.scrollTop).toBe(160);

    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(160);
  });

  it("does not repin late restoration during the initial observer grace window", () => {
    mountHarness();

    if (!scrollContainer) {
      throw new Error("expected scroll container");
    }
    expect(scrollContainer.scrollTop).toBe(1000);

    scrollContainer.scrollTop = 180;
    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer.scrollTop).toBe(180);
  });

  it("keeps pinned transcript growth at the bottom after one observer frame", () => {
    mountHarness();
    flushInitialScroll();

    expect(scrollContainer?.scrollTop).toBe(1000);

    scrollHeightValue = 1100;
    act(() => {
      triggerResize();
    });

    expect(scrollContainer?.scrollTop).toBe(1000);

    act(() => {
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(1100);
  });

  it("keeps pinned large async transcript growth during initial restoration grace", () => {
    mountHarness();

    expect(scrollContainer?.scrollTop).toBe(1000);

    scrollHeightValue = 1700;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(1700);
  });

  it("keeps repeated pinned transcript growth during initial restoration grace", () => {
    mountHarness();

    expect(scrollContainer?.scrollTop).toBe(1000);

    scrollHeightValue = 1700;
    act(() => {
      triggerResize();
      flushRaf();
    });
    expect(scrollContainer?.scrollTop).toBe(1700);

    scrollHeightValue = 1800;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(1800);
  });

  it("avoids at-bottom layout reads for pinned transcript growth", () => {
    mountHarness();
    flushInitialScroll();
    scrollHeightReadCount = 0;
    clientHeightReadCount = 0;

    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer?.scrollTop).toBe(1200);
    expect(clientHeightReadCount).toBe(0);
    expect(scrollHeightReadCount).toBe(1);
  });

  it("does not auto-pin immediately after a manual scroll up", () => {
    mountHarness();
    flushInitialScroll();

    if (!scrollContainer) {
      throw new Error("expected scroll container");
    }

    scrollContainer.scrollTop = 100;
    act(() => {
      scrollContainer?.dispatchEvent(new Event("scroll"));
      flushRaf();
    });

    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
      flushRaf();
    });

    expect(scrollContainer.scrollTop).toBe(100);
  });

  it("lets manual scroll-up beat already scheduled transcript growth", () => {
    mountHarness();
    flushInitialScroll();

    if (!scrollContainer) {
      throw new Error("expected scroll container");
    }

    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
    });

    scrollContainer.scrollTop = 100;
    act(() => {
      scrollContainer?.dispatchEvent(new Event("scroll"));
      flushRaf();
    });

    expect(scrollContainer.scrollTop).toBe(100);
  });

  it("keeps smooth imperative scrolling on the sentinel element", () => {
    mountHarness();
    flushInitialScroll();

    const sentinel = scrollContainer?.querySelector(
      '[data-testid="messages-end"]',
    );
    if (!(sentinel instanceof HTMLElement)) {
      throw new Error("expected messages end sentinel");
    }
    const scrollIntoView = vi.fn();
    sentinel.scrollIntoView = scrollIntoView;

    act(() => {
      forceScrollToBottom?.("smooth");
    });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "end",
    });
  });

  it("cancels pending observer scroll checks on unmount", () => {
    mountHarness();
    scrollHeightValue = 1200;
    act(() => {
      triggerResize();
    });
    if (!scrollContainer) {
      throw new Error("expected scroll container");
    }
    const detachedScrollContainer = scrollContainer;
    scrollContainer.scrollTop = 200;

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      flushRaf();
    });

    expect(detachedScrollContainer.scrollTop).toBe(200);
  });

  it("ignores observer callbacks delivered after unmount", () => {
    mountHarness();
    const staleResizeCallback = resizeCallbacks.at(-1);
    if (!staleResizeCallback || !scrollContainer) {
      throw new Error("expected resize callback and scroll container");
    }
    const detachedScrollContainer = scrollContainer;
    scrollHeightValue = 1200;

    act(() => root.unmount());
    root = createRoot(container);
    initialScrollTop = 250;
    scrollHeightValue = 900;
    mountHarness();
    if (!scrollContainer) {
      throw new Error("expected remounted scroll container");
    }
    scrollContainer.scrollTop = 250;

    act(() => {
      staleResizeCallback([], {} as ResizeObserver);
      flushRaf();
    });

    expect(detachedScrollContainer.scrollTop).toBe(1000);
    expect(scrollContainer.scrollTop).toBe(250);
  });

  it("cancels pending imperative auto-scroll on unmount", () => {
    mountHarness();
    if (!scrollContainer) {
      throw new Error("expected scroll container");
    }
    const detachedScrollContainer = scrollContainer;
    scrollContainer.scrollTop = 200;

    act(() => {
      forceScrollToBottom?.("auto");
    });
    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      flushRaf();
    });

    expect(detachedScrollContainer.scrollTop).toBe(200);
  });
});
