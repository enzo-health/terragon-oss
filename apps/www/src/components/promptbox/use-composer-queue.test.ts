/* @vitest-environment jsdom */

import type { DBUserMessage } from "@terragon/shared";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useComposerQueue,
  type UseComposerQueueOptions,
} from "./use-composer-queue";

// ---------------------------------------------------------------------------
// Minimal renderHook shim (same pattern as use-stable-ref.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string): DBUserMessage {
  return {
    type: "user",
    model: null,
    parts: [{ type: "text", text }],
  };
}

const msgA = makeMessage("A");
const msgB = makeMessage("B");
const msgC = makeMessage("C");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useComposerQueue", () => {
  const mounted: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      vi.runAllTimers();
    });
    vi.useRealTimers();
    while (mounted.length > 0) mounted.pop()?.();
  });

  it("calls append directly when not working, queue stays empty", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const onQueueChange = vi.fn();

    const { result, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: false, append, onQueueChange },
    );
    mounted.push(unmount);

    await act(async () => {
      await result.current.submitOrQueue(msgA);
    });

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(msgA);
    expect(result.current.queue).toHaveLength(0);
    expect(onQueueChange).not.toHaveBeenCalled();
  });

  it("adds to queue when working, append NOT called, onQueueChange fires", async () => {
    const append = vi.fn();
    const onQueueChange = vi.fn();

    const { result, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append, onQueueChange },
    );
    mounted.push(unmount);

    await act(async () => {
      await result.current.submitOrQueue(msgA);
    });

    expect(append).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]).toBe(msgA);
    expect(onQueueChange).toHaveBeenCalledOnce();
    expect(onQueueChange).toHaveBeenCalledWith([msgA]);
  });

  it("drains queue in order when isWorking transitions false, onQueueChange fires with []", async () => {
    const callOrder: string[] = [];
    const append = vi.fn().mockImplementation(async (msg: DBUserMessage) => {
      callOrder.push((msg.parts[0] as { text: string }).text);
    });
    const onQueueChange = vi.fn();

    const { result, rerender, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append, onQueueChange },
    );
    mounted.push(unmount);

    // Queue two messages while working.
    await act(async () => {
      await result.current.submitOrQueue(msgA);
      await result.current.submitOrQueue(msgB);
    });

    expect(result.current.queue).toHaveLength(2);
    expect(append).not.toHaveBeenCalled();

    // Transition to not working — should trigger auto-drain.
    await act(async () => {
      rerender({ isWorking: false, append, onQueueChange });
    });

    expect(append).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["A", "B"]);
    expect(result.current.queue).toHaveLength(0);
    // onQueueChange should have been called with [] after drain.
    expect(onQueueChange).toHaveBeenLastCalledWith([]);
  });

  it("removeFromQueue removes message at index, onQueueChange fires with new queue", async () => {
    const append = vi.fn();
    const onQueueChange = vi.fn();

    const { result, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append, onQueueChange },
    );
    mounted.push(unmount);

    await act(async () => {
      await result.current.submitOrQueue(msgA);
      await result.current.submitOrQueue(msgB);
      await result.current.submitOrQueue(msgC);
    });

    expect(result.current.queue).toHaveLength(3);

    // Remove the middle message (index 1 = msgB).
    act(() => {
      result.current.removeFromQueue(1);
    });

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queue[0]).toBe(msgA);
    expect(result.current.queue[1]).toBe(msgC);
    expect(onQueueChange).toHaveBeenLastCalledWith([msgA, msgC]);
  });

  it("multiple messages queued in one working session all drain in submission order", async () => {
    const drained: DBUserMessage[] = [];
    const append = vi.fn().mockImplementation(async (msg: DBUserMessage) => {
      drained.push(msg);
    });

    const { result, rerender, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append },
    );
    mounted.push(unmount);

    await act(async () => {
      await result.current.submitOrQueue(msgA);
      await result.current.submitOrQueue(msgB);
      await result.current.submitOrQueue(msgC);
    });

    expect(result.current.queue).toHaveLength(3);

    await act(async () => {
      rerender({ isWorking: false, append });
    });

    expect(drained).toEqual([msgA, msgB, msgC]);
    expect(result.current.queue).toHaveLength(0);
  });

  it("drain() while working force-drains the queue", async () => {
    const drained: DBUserMessage[] = [];
    const append = vi.fn().mockImplementation(async (msg: DBUserMessage) => {
      drained.push(msg);
    });

    const { result, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append },
    );
    mounted.push(unmount);

    await act(async () => {
      await result.current.submitOrQueue(msgA);
      await result.current.submitOrQueue(msgB);
    });

    expect(result.current.queue).toHaveLength(2);

    // Still working but manually draining.
    await act(async () => {
      await result.current.drain();
    });

    expect(append).toHaveBeenCalledTimes(2);
    expect(drained).toEqual([msgA, msgB]);
    expect(result.current.queue).toHaveLength(0);
  });

  it("stale closure: if append identity changes mid-queue, latest one is used on drain", async () => {
    const firstAppend = vi.fn().mockResolvedValue(undefined);
    const secondAppend = vi.fn().mockResolvedValue(undefined);

    const { result, rerender, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append: firstAppend },
    );
    mounted.push(unmount);

    // Queue a message while the first append is in place.
    await act(async () => {
      await result.current.submitOrQueue(msgA);
    });

    // Swap the append callback (simulating parent re-render), still working.
    await act(async () => {
      rerender({ isWorking: true, append: secondAppend });
    });

    // Now transition to not working — drain should use secondAppend.
    await act(async () => {
      rerender({ isWorking: false, append: secondAppend });
    });

    expect(firstAppend).not.toHaveBeenCalled();
    expect(secondAppend).toHaveBeenCalledOnce();
    expect(secondAppend).toHaveBeenCalledWith(msgA);
  });

  it("initialQueue is used as the starting queue contents", () => {
    const append = vi.fn();
    const initial = [msgA, msgB] as const;

    const { result, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append, initialQueue: initial },
    );
    mounted.push(unmount);

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queue[0]).toBe(msgA);
    expect(result.current.queue[1]).toBe(msgB);
  });

  it("does not re-drain when staying not-working across rerenders", async () => {
    const append = vi.fn().mockResolvedValue(undefined);

    const { rerender, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: false, append },
    );
    mounted.push(unmount);

    // Multiple rerenders while already not-working — drain must not fire.
    await act(async () => {
      rerender({ isWorking: false, append });
      rerender({ isWorking: false, append });
    });

    expect(append).not.toHaveBeenCalled();
  });

  it("does not drain when isWorking stays true across rerenders", async () => {
    const append = vi.fn();

    const { result, rerender, unmount } = renderHook(
      (opts: UseComposerQueueOptions) => useComposerQueue(opts),
      { isWorking: true, append },
    );
    mounted.push(unmount);

    await act(async () => {
      await result.current.submitOrQueue(msgA);
    });

    await act(async () => {
      rerender({ isWorking: true, append });
      rerender({ isWorking: true, append });
    });

    expect(append).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(1);
  });
});
