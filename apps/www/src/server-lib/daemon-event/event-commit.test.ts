import { EventType } from "@ag-ui/core";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import { describe, expect, it } from "vitest";
import {
  buildPreLegacyAgUiCommitPlan,
  buildTerminalAgUiCommitPlan,
  filterCanonicalEventsForDeltaCoexistence,
  type CanonicalEventsPayload,
  type DaemonEventEnvelopeV2,
} from "./event-commit";

const baseEvent = {
  payloadVersion: 2,
  runId: "run-1",
  threadId: "thread-1",
  threadChatId: "chat-1",
  timestamp: "2026-05-31T00:00:00.000Z",
} as const;

const envelopeV2: DaemonEventEnvelopeV2 = {
  payloadVersion: 2,
  eventId: "event-1",
  runId: "run-1",
  seq: 10,
};

function createRunStartedEvent(
  eventId = "canonical-start",
): CanonicalEventsPayload[number] {
  return {
    ...baseEvent,
    eventId,
    seq: 1,
    category: "operational",
    type: "run-started",
    agent: "claudeCode",
    transportMode: "acp",
    protocolVersion: 2,
  };
}

function createAssistantMessageEvent(): CanonicalEventsPayload[number] {
  return {
    ...baseEvent,
    eventId: "canonical-assistant",
    seq: 2,
    category: "transcript",
    type: "assistant-message",
    messageId: "message-1",
    content: "streamed already",
  };
}

function createUnknownProviderEvent(): CanonicalEventsPayload[number] {
  return {
    ...baseEvent,
    eventId: "canonical-unknown",
    seq: 3,
    category: "quarantine",
    type: "unknown-provider-event",
    provider: "acp",
    rawEventType: "test.event",
    redactedPayload: {},
    reason: "fixture",
  };
}

function createRunTerminalEvent(): CanonicalEventsPayload[number] {
  return {
    ...baseEvent,
    eventId: "canonical-terminal",
    seq: 4,
    category: "operational",
    type: "run-terminal",
    status: "completed",
    errorMessage: null,
    errorCode: null,
    headShaAtCompletion: null,
  };
}

function createDelta(): NonNullable<DaemonEventAPIBody["deltas"]>[number] {
  return {
    messageId: "message-1",
    partIndex: 0,
    deltaSeq: 1,
    kind: "text",
    text: "hello",
  };
}

function createRichPartMessage(): DaemonEventAPIBody["messages"][number] {
  return {
    type: "acp-plan",
    session_id: "session-1",
    entries: [
      {
        id: "step-1",
        content: "Run tests",
        priority: "medium",
        status: "pending",
      },
    ],
  };
}

describe("daemon runtime event commit planning", () => {
  it("drops canonical assistant messages when deltas own the stream", () => {
    const filtered = filterCanonicalEventsForDeltaCoexistence({
      canonicalEvents: [createAssistantMessageEvent(), createRunStartedEvent()],
      deltas: [createDelta()],
    });

    expect(filtered?.map((event) => event.type)).toEqual(["run-started"]);
  });

  it("builds a single pre-legacy commit plan for canonical, delta, and rich rows", () => {
    const plan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [createRichPartMessage()],
      canonicalEventsForPersistence: [createRunStartedEvent()],
      deltas: [createDelta()],
      runId: "run-1",
    });

    expect(plan.requiresPersistence).toBe(true);
    expect(plan.canonicalRows).toHaveLength(1);
    expect(plan.deltaRows.map((row) => row.eventId)).toEqual([
      "delta-start:run-1:message-1:text",
      "delta:run-1:message-1:0:text:1",
    ]);
    expect(plan.richPartRows).toHaveLength(1);
    expect(plan.mergedRows.map((row) => row.eventId)).toEqual([
      "canonical-start:RUN_STARTED:0",
      "delta-start:run-1:message-1:text",
      "delta:run-1:message-1:0:text:1",
      "msg:event-1:msg:0:CUSTOM:0",
    ]);
  });

  it("does not require persistence when canonical inputs expand to no AG-UI rows", () => {
    const plan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: false,
      envelopeV2,
      messages: [],
      canonicalEventsForPersistence: [createUnknownProviderEvent()],
      deltas: null,
      runId: "run-1",
    });

    expect(plan.requiresPersistence).toBe(false);
    expect(plan.mergedRows).toEqual([]);
  });

  it("keeps synthetic delta end rows before terminal canonical rows", () => {
    const plan = buildTerminalAgUiCommitPlan({
      terminalCanonicalEventsForPersistence: [createRunTerminalEvent()],
      deltaEndRows: [
        {
          eventId: "delta-end:run-1:message-1:text",
          timestamp: new Date("2026-05-31T00:00:01.000Z"),
          event: {
            type: EventType.TEXT_MESSAGE_END,
            messageId: "message-1",
          },
        },
      ],
    });

    expect(plan.terminalMergedRows.map((row) => row.eventId)).toEqual([
      "delta-end:run-1:message-1:text",
      "canonical-terminal:RUN_FINISHED:0",
    ]);
  });
});
