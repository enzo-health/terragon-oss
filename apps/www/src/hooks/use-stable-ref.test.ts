/* @vitest-environment jsdom */

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStableRef } from "./use-stable-ref";

/**
 * Minimal render-hook shim. Mounts a component that calls the hook with
 * props from a mutable holder, captures the latest return value, and
 * exposes a `rerender` that mutates the holder + forces a re-render.
 */
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

describe("useStableRef", () => {
  const mounted: Array<() => void> = [];

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.();
  });

  it("returns initial value on first render", () => {
    const initial = { x: 1 };
    const isEqual = vi.fn((a: { x: number }, b: { x: number }) => a.x === b.x);
    const { result, unmount } = renderHook(
      ({ value }: { value: { x: number } }) => useStableRef(value, isEqual),
      { value: initial },
    );
    mounted.push(unmount);

    expect(result.current).toBe(initial);
    expect(isEqual).not.toHaveBeenCalled();
  });

  it("returns prior ref when isEqual returns true", () => {
    const initial = { x: 1 };
    const isEqual = vi.fn((a: { x: number }, b: { x: number }) => a.x === b.x);
    const { result, rerender, unmount } = renderHook(
      ({ value }: { value: { x: number } }) => useStableRef(value, isEqual),
      { value: initial },
    );
    mounted.push(unmount);

    const next = { x: 1 };
    expect(next).not.toBe(initial);
    rerender({ value: next });

    expect(result.current).toBe(initial);
    expect(isEqual).toHaveBeenCalledTimes(1);
    expect(isEqual).toHaveBeenCalledWith(initial, next);
  });

  it("returns new ref when isEqual returns false", () => {
    const initial = { x: 1 };
    const isEqual = vi.fn((a: { x: number }, b: { x: number }) => a.x === b.x);
    const { result, rerender, unmount } = renderHook(
      ({ value }: { value: { x: number } }) => useStableRef(value, isEqual),
      { value: initial },
    );
    mounted.push(unmount);

    const next = { x: 2 };
    rerender({ value: next });

    expect(result.current).toBe(next);
    expect(isEqual).toHaveBeenCalledTimes(1);
  });

  it("does not call isEqual when value reference is identical", () => {
    const initial = { x: 1 };
    const isEqual = vi.fn((a: { x: number }, b: { x: number }) => a.x === b.x);
    const { result, rerender, unmount } = renderHook(
      ({ value }: { value: { x: number } }) => useStableRef(value, isEqual),
      { value: initial },
    );
    mounted.push(unmount);

    // Rerender with the exact same object reference.
    rerender({ value: initial });

    expect(result.current).toBe(initial);
    // The `ref.current !== value` guard in the hook short-circuits before
    // calling `isEqual`.
    expect(isEqual).not.toHaveBeenCalled();
  });
});
