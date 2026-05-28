import { EventType, type BaseEvent } from "@ag-ui/core";
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import { Observable, Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { createAgUiDeltaCoalescingMiddleware } from "./ag-ui-delta-coalescing";

function asAgentRun(
  observable: Observable<BaseEvent>,
): ReturnType<AbstractAgent["run"]> {
  return observable as unknown as ReturnType<AbstractAgent["run"]>;
}

function makeAgent(events: BaseEvent[]): AbstractAgent {
  return {
    run: () =>
      asAgentRun(
        new Observable<BaseEvent>((subscriber) => {
          for (const event of events) {
            subscriber.next(event);
          }
          subscriber.complete();
        }),
      ),
  } as unknown as AbstractAgent;
}

async function collectEvents(events: BaseEvent[]): Promise<BaseEvent[]> {
  const middleware = createAgUiDeltaCoalescingMiddleware();
  const emitted: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    middleware({} as RunAgentInput, makeAgent(events)).subscribe({
      next: (event) => emitted.push(event),
      error: reject,
      complete: resolve,
    });
  });
  return emitted;
}

describe("createAgUiDeltaCoalescingMiddleware", () => {
  it("coalesces adjacent text deltas for the same message", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hel",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "lo",
      } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hello",
      },
    ]);
  });

  it("flushes before non-delta events so message ordering stays intact", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hello",
      } as BaseEvent,
      {
        type: EventType.CUSTOM,
        name: "artifact-reference",
        value: { artifactId: "a1" },
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: " again",
      } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hello",
      },
      {
        type: EventType.CUSTOM,
        name: "artifact-reference",
        value: { artifactId: "a1" },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: " again",
      },
    ]);
  });

  it("flushes pending content before errors", async () => {
    const emitted: BaseEvent[] = [];
    const error = new Error("stream failed");
    const agent = {
      run: () =>
        asAgentRun(
          new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "m1",
              delta: "before failure",
            } as BaseEvent);
            subscriber.error(error);
          }),
        ),
    } as unknown as AbstractAgent;

    await expect(
      new Promise<void>((resolve, reject) => {
        createAgUiDeltaCoalescingMiddleware()(
          {} as RunAgentInput,
          agent,
        ).subscribe({
          next: (event) => emitted.push(event),
          error: reject,
          complete: resolve,
        });
      }),
    ).rejects.toBe(error);

    expect(emitted).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "before failure",
      },
    ]);
  });

  it("flushes pending content before terminal run events", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "final token",
      } as BaseEvent,
      { type: EventType.RUN_FINISHED, runId: "run-1" } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "final token",
      },
      { type: EventType.RUN_FINISHED, runId: "run-1" },
    ]);
  });

  it("collapses a burst of text deltas into one frame event", async () => {
    const emitted = await collectEvents(
      Array.from(
        { length: 100 },
        (_, index) =>
          ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "m1",
            delta: String(index % 10),
          }) as BaseEvent,
      ),
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta:
        "01234567890123456789012345678901234567890123456789" +
        "01234567890123456789012345678901234567890123456789",
    });
  });

  it("coalesces adjacent tool argument deltas for the same tool call", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm ',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: 'test"}',
      } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm test"}',
      },
    ]);
  });

  it("keeps different tool argument streams separate", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: "a",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-2",
        delta: "b",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-2",
        delta: "c",
      } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: "a",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-2",
        delta: "bc",
      },
    ]);
  });

  it("flushes pending tool arguments before tool end events", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm test"}',
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tool-1" } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm test"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "tool-1" },
    ]);
  });

  it("keeps different message and reasoning streams separate", async () => {
    const emitted = await collectEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m2",
        delta: "b",
      } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "c",
      } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "d",
      } as BaseEvent,
    ]);

    expect(emitted).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m2",
        delta: "b",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "cd",
      },
    ]);
  });

  it("flushes on the animation frame while a stream remains open", async () => {
    vi.useFakeTimers();
    try {
      const events = [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "a",
        } as BaseEvent,
      ];
      const emitted: BaseEvent[] = [];
      const agent = {
        run: () =>
          asAgentRun(
            new Observable<BaseEvent>((subscriber) => {
              subscriber.next(events[0]!);
            }),
          ),
      } as unknown as AbstractAgent;
      const subscription = createAgUiDeltaCoalescingMiddleware()(
        {} as RunAgentInput,
        agent,
      ).subscribe((event) => emitted.push(event));

      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(16);
      expect(emitted).toEqual(events);

      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes on timeout when requestAnimationFrame is paused", async () => {
    vi.useFakeTimers();
    const requestAnimationFrame = vi.fn(() => 1);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("window", {
      requestAnimationFrame,
      cancelAnimationFrame,
    });
    try {
      const event = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hidden tab token",
      } as BaseEvent;
      const emitted: BaseEvent[] = [];
      const agent = {
        run: () =>
          asAgentRun(
            new Observable<BaseEvent>((subscriber) => {
              subscriber.next(event);
            }),
          ),
      } as unknown as AbstractAgent;
      const subscription = createAgUiDeltaCoalescingMiddleware()(
        {} as RunAgentInput,
        agent,
      ).subscribe((emittedEvent) => emitted.push(emittedEvent));

      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(16);
      expect(emitted).toEqual([event]);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(1);

      subscription.unsubscribe();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not emit stale pending deltas after downstream unsubscribe", () => {
    vi.useFakeTimers();
    try {
      const event = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "cancelled token",
      } as BaseEvent;
      const upstreamUnsubscribe = vi.fn();
      const emitted: BaseEvent[] = [];
      const agent = {
        run: () =>
          asAgentRun(
            new Observable<BaseEvent>((subscriber) => {
              subscriber.next(event);
              return upstreamUnsubscribe;
            }),
          ),
      } as unknown as AbstractAgent;

      const subscription = createAgUiDeltaCoalescingMiddleware()(
        {} as RunAgentInput,
        agent,
      ).subscribe((emittedEvent) => emitted.push(emittedEvent));

      expect(emitted).toEqual([]);
      subscription.unsubscribe();
      vi.advanceTimersByTime(16);
      expect(emitted).toEqual([]);
      expect(upstreamUnsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps Observable subclasses without depending on their constructor", () => {
    vi.useFakeTimers();
    try {
      const source = new Subject<BaseEvent>();
      const emitted: BaseEvent[] = [];
      const agent = {
        run: () => asAgentRun(source),
      } as unknown as AbstractAgent;

      const subscription = createAgUiDeltaCoalescingMiddleware()(
        {} as RunAgentInput,
        agent,
      ).subscribe((event) => emitted.push(event));

      source.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "subject ",
      } as BaseEvent);
      source.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "works",
      } as BaseEvent);
      vi.advanceTimersByTime(16);

      expect(emitted).toEqual([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "subject works",
        },
      ]);

      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
