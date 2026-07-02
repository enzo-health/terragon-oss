/* @vitest-environment jsdom */

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "./use-delayed-flag";

function renderHook<TProps, TResult>(
  hook: (props: TProps) => TResult,
  initialProps: TProps,
): {
  result: { current: TResult };
  rerender: (props: TProps) => void;
  unmount: () => void;
} {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  const result: { current: TResult } = {
    current: undefined as unknown as TResult,
  };
  let setProps: (p: TProps) => void = () => {};

  function Harness({ initial }: { initial: TProps }) {
    const [props, setPropsInner] = useState<TProps>(initial);
    setProps = setPropsInner;
    result.current = hook(props);
    return null;
  }

  act(() => {
    root.render(createElement(Harness, { initial: initialProps }));
  });

  return {
    result,
    rerender: (props: TProps) => {
      act(() => {
        setProps(props);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe("useDelayedFlag", () => {
  const mounted: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.();
    vi.useRealTimers();
  });

  it("is false immediately when active turns true", () => {
    const { result, unmount } = renderHook(
      ({ active }: { active: boolean }) => useDelayedFlag(active, 250),
      { active: true },
    );
    mounted.push(unmount);

    expect(result.current).toBe(false);
  });

  it("becomes true only after the delay elapses", () => {
    const { result, unmount } = renderHook(
      ({ active }: { active: boolean }) => useDelayedFlag(active, 250),
      { active: true },
    );
    mounted.push(unmount);

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("never flips true when active clears before the delay", () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => useDelayedFlag(active, 250),
      { active: true },
    );
    mounted.push(unmount);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it("resets to false when active clears after having elapsed", () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => useDelayedFlag(active, 250),
      { active: true },
    );
    mounted.push(unmount);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
