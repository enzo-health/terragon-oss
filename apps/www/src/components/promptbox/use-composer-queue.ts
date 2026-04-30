import type { DBUserMessage } from "@terragon/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type ComposerQueueAppend = (
  message: DBUserMessage,
) => void | Promise<void>;

export interface UseComposerQueueOptions {
  /**
   * True when the agent is working and new messages should be buffered.
   * Caller derives this from ThreadStatus via isAgentWorking().
   */
  isWorking: boolean;
  /**
   * The actual append function — called immediately when not working, or
   * to drain the queue when isWorking flips false.
   */
  append: ComposerQueueAppend;
  /** Existing queued messages from server state (rehydrated on mount). */
  initialQueue?: readonly DBUserMessage[];
  /**
   * Notify the caller when the queue changes (e.g., to persist to
   * thread-view-model). Optional.
   */
  onQueueChange?: (queue: readonly DBUserMessage[]) => void;
}

export interface UseComposerQueueResult {
  /** Call this instead of append directly. Either submits or queues based on isWorking. */
  submitOrQueue: (message: DBUserMessage) => Promise<void>;
  /** Current queue contents. */
  queue: readonly DBUserMessage[];
  /** Manually remove a queued message (for the X button on QueuedMessages). */
  removeFromQueue: (index: number) => void;
  /** Manually drain (e.g., when user explicitly hits "send all now"). */
  drain: () => Promise<void>;
}

export function useComposerQueue(
  options: UseComposerQueueOptions,
): UseComposerQueueResult {
  const { isWorking, initialQueue } = options;

  const [queue, setQueue] = useState<readonly DBUserMessage[]>(
    initialQueue ?? [],
  );

  // Stable refs so drain/effect closures always see the latest callbacks
  // without their identity changes triggering re-runs.
  const appendRef = useRef<ComposerQueueAppend>(options.append);
  appendRef.current = options.append;

  const onQueueChangeRef = useRef<
    ((q: readonly DBUserMessage[]) => void) | undefined
  >(options.onQueueChange);
  onQueueChangeRef.current = options.onQueueChange;

  // Track mount state to abort drain if the component unmounts mid-drain.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Internal drain implementation. Reads the queue snapshot passed in so
  // callers can flush an in-flight snapshot without racing against setState.
  const drainSnapshot = useCallback(
    async (snapshot: readonly DBUserMessage[]): Promise<void> => {
      for (const message of snapshot) {
        if (!isMountedRef.current) break;
        await appendRef.current(message);
      }
      if (!isMountedRef.current) return;
      setQueue([]);
      onQueueChangeRef.current?.([]);
    },
    [],
  );

  // Auto-drain when isWorking transitions true → false.
  const prevIsWorkingRef = useRef(isWorking);
  useEffect(() => {
    const wasWorking = prevIsWorkingRef.current;
    prevIsWorkingRef.current = isWorking;

    if (wasWorking && !isWorking) {
      // Capture the queue at the moment of transition. setQueue updater form
      // lets us read the current value without closing over stale state.
      setQueue((current) => {
        if (current.length > 0) {
          // Schedule the drain asynchronously so we don't call setState
          // inside another setState (the updater).
          void drainSnapshot(current);
        }
        return current;
      });
    }
  }, [isWorking, drainSnapshot]);

  const submitOrQueue = useCallback(
    async (message: DBUserMessage): Promise<void> => {
      // Re-read isWorking from options via closure — this is intentional.
      // The ref approach is for callbacks (append/onQueueChange) only;
      // isWorking is a primitive that reacts correctly via hook re-renders.
      if (options.isWorking) {
        setQueue((prev) => {
          const next = [...prev, message];
          onQueueChangeRef.current?.(next);
          return next;
        });
      } else {
        await appendRef.current(message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.isWorking],
  );

  const removeFromQueue = useCallback((index: number): void => {
    setQueue((prev) => {
      const next = prev.filter((_, i) => i !== index);
      onQueueChangeRef.current?.(next);
      return next;
    });
  }, []);

  const drain = useCallback(async (): Promise<void> => {
    // Force-drain: capture current queue and drain it immediately regardless
    // of isWorking state.
    setQueue((current) => {
      if (current.length > 0) {
        void drainSnapshot(current);
      }
      return current;
    });
  }, [drainSnapshot]);

  return { submitOrQueue, queue, removeFromQueue, drain };
}
