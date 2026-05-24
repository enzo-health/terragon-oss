import { describe, expect, it, vi } from "vitest";
import { HttpAgent, type AgentSubscriberParams } from "@ag-ui/client";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { createTerragonAgUiSubscriber } from "./terragon-ag-ui-subscriber";
import type { TerragonRunEvent } from "./terragon-run-aggregator";

const input = {
  threadId: "thread-1",
  runId: "run-1",
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
} satisfies RunAgentInput;

const subscriberParams = {
  messages: [],
  state: {},
  agent: new HttpAgent({ url: "/test-ag-ui" }),
  input,
} satisfies AgentSubscriberParams;

describe("createTerragonAgUiSubscriber", () => {
  it("claims AG-UI events so Terragon is the only live transcript folder", async () => {
    const dispatch = vi.fn<(event: TerragonRunEvent) => void>();
    const subscriber = createTerragonAgUiSubscriber({
      dispatch,
      runId: "run-1",
    });

    const result = await subscriber.onEvent?.({
      ...subscriberParams,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-live",
        delta: "hello",
      },
    });

    expect(result).toEqual({ stopPropagation: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-live",
      delta: "hello",
    });
  });

  it("does not double-dispatch lifecycle events owned by runtime setup/finalize", async () => {
    const dispatch = vi.fn<(event: TerragonRunEvent) => void>();
    const subscriber = createTerragonAgUiSubscriber({
      dispatch,
      runId: "run-1",
    });

    await subscriber.onEvent?.({
      ...subscriberParams,
      event: {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      },
    });
    await subscriber.onEvent?.({
      ...subscriberParams,
      event: {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      },
    });
    await subscriber.onRunFinalized?.(subscriberParams);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: EventType.RUN_FINISHED,
      runId: "run-1",
    });
  });

  it("leaves AG-UI event families that Terragon does not project to the SDK", async () => {
    const dispatch = vi.fn<(event: TerragonRunEvent) => void>();
    const subscriber = createTerragonAgUiSubscriber({
      dispatch,
      runId: "run-1",
    });

    const result = await subscriber.onEvent?.({
      ...subscriberParams,
      event: {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "status",
        content: { text: "queued" },
      },
    });

    expect(result).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
