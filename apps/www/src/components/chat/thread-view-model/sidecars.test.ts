import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  createProductSidecarEventProjector,
  createThreadViewSidecarEventProjector,
  isProductSidecarEvent,
} from "./sidecars";

describe("thread view sidecars", () => {
  it("drops transcript event families", () => {
    const projector = createThreadViewSidecarEventProjector<BaseEvent>();
    const transcriptEvents: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "token",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "thinking-1",
        delta: "thought",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: "{}",
      },
      {
        type: EventType.CUSTOM,
        name: "terragon.data-part",
        value: {},
      },
    ] as BaseEvent[];

    expect(transcriptEvents.map((event) => projector(event))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("allows only product sidecars through the product projector", () => {
    const projector = createProductSidecarEventProjector<BaseEvent>();
    const artifactEvent = {
      type: EventType.CUSTOM,
      name: "artifact-reference",
      value: { artifactId: "plan-1" },
    } as BaseEvent;
    const metaEvent = {
      type: EventType.CUSTOM,
      name: "thread.token_usage_updated",
      value: { kind: "thread.token_usage_updated" },
    } as BaseEvent;
    const snapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [],
    } as BaseEvent;

    expect(isProductSidecarEvent(artifactEvent)).toBe(true);
    expect(isProductSidecarEvent(metaEvent)).toBe(true);
    expect(isProductSidecarEvent(snapshotEvent)).toBe(false);
    expect(projector(artifactEvent)).toBe(artifactEvent);
    expect(projector(metaEvent)).toBe(metaEvent);
    expect(projector(snapshotEvent)).toBeNull();
  });
});
