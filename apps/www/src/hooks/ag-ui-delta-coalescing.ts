import { EventType, type BaseEvent } from "@ag-ui/core";
import type {
  AbstractAgent,
  MiddlewareFunction,
  RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";

type CoalescableDeltaEvent = BaseEvent & {
  type:
    | EventType.TEXT_MESSAGE_CONTENT
    | EventType.REASONING_MESSAGE_CONTENT
    | EventType.TOOL_CALL_ARGS;
  delta: string;
} & ({ messageId: string } | { toolCallId: string });

const COALESCE_FRAME_MS = 16;

function isCoalescableDeltaEvent(
  event: BaseEvent,
): event is CoalescableDeltaEvent {
  return (
    (event.type === EventType.TEXT_MESSAGE_CONTENT ||
      event.type === EventType.REASONING_MESSAGE_CONTENT ||
      event.type === EventType.TOOL_CALL_ARGS) &&
    "delta" in event &&
    typeof event.delta === "string" &&
    (("messageId" in event && typeof event.messageId === "string") ||
      ("toolCallId" in event && typeof event.toolCallId === "string"))
  );
}

function coalescableDeltaKey(event: CoalescableDeltaEvent): string {
  if ("messageId" in event) {
    return `${event.type}:${event.messageId}`;
  }
  return `${event.type}:${event.toolCallId}`;
}

type PendingDelta = {
  event: CoalescableDeltaEvent;
  key: string;
  delta: string;
};

function createPendingDelta(event: CoalescableDeltaEvent): PendingDelta {
  return {
    event,
    key: coalescableDeltaKey(event),
    delta: event.delta,
  };
}

function appendPendingDelta(
  pending: PendingDelta,
  event: CoalescableDeltaEvent,
): boolean {
  if (pending.key !== coalescableDeltaKey(event)) {
    return false;
  }
  pending.event = event;
  pending.delta += event.delta;
  return true;
}

function pendingDeltaToEvent(pending: PendingDelta): CoalescableDeltaEvent {
  return {
    ...pending.event,
    delta: pending.delta,
  } as CoalescableDeltaEvent;
}

function scheduleFrameFlush(callback: () => void): () => void {
  let cancelled = false;
  let animationFrameId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (
      animationFrameId !== null &&
      typeof window !== "undefined" &&
      window.cancelAnimationFrame
    ) {
      window.cancelAnimationFrame(animationFrameId);
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  };

  const flush = () => {
    if (cancelled) return;
    cancel();
    callback();
  };

  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    animationFrameId = window.requestAnimationFrame(flush);
  }
  timeoutId = setTimeout(flush, COALESCE_FRAME_MS);
  return cancel;
}

export const createAgUiDeltaCoalescingMiddleware =
  (): MiddlewareFunction =>
  (
    input: RunAgentInput,
    next: AbstractAgent,
  ): ReturnType<AbstractAgent["run"]> => {
    const source = next.run(input);

    return new Observable<BaseEvent>((subscriber) => {
      let pending: PendingDelta | null = null;
      let cancelScheduledFlush: (() => void) | null = null;

      const clearScheduledFlush = () => {
        cancelScheduledFlush?.();
        cancelScheduledFlush = null;
      };

      const flush = () => {
        clearScheduledFlush();
        if (!pending) return;
        const event = pendingDeltaToEvent(pending);
        pending = null;
        subscriber.next(event);
      };

      const scheduleFlush = () => {
        if (cancelScheduledFlush) return;
        cancelScheduledFlush = scheduleFrameFlush(flush);
      };

      const subscription = source.subscribe({
        next: (event) => {
          if (isCoalescableDeltaEvent(event)) {
            if (!pending) {
              pending = createPendingDelta(event);
              scheduleFlush();
              return;
            }
            if (appendPendingDelta(pending, event)) {
              return;
            }
          }

          flush();
          if (isCoalescableDeltaEvent(event)) {
            pending = createPendingDelta(event);
            scheduleFlush();
            return;
          }
          subscriber.next(event);
        },
        error: (error) => {
          flush();
          subscriber.error(error);
        },
        complete: () => {
          flush();
          subscriber.complete();
        },
      });

      return () => {
        clearScheduledFlush();
        pending = null;
        subscription.unsubscribe();
      };
    }) as ReturnType<AbstractAgent["run"]>;
  };
