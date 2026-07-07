import { EventType } from "@ag-ui/core";
import {
  agUiWireRowsToRows,
  buildStandardAgUiWireRows,
} from "@terragon/agent/ag-ui-rows";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPreLegacyAgUiCommitPlan,
  buildTerminalAgUiCommitPlan,
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

function createProviderRichPlanEvent(
  eventId = "canonical-rich-plan",
): CanonicalEventsPayload[number] {
  return {
    ...baseEvent,
    eventId,
    seq: 2,
    category: "artifact",
    type: "provider-rich-part",
    richKind: "acp-plan",
    payload: {
      entries: [
        {
          id: "step-1",
          content: "Run tests",
          priority: "medium",
          status: "pending",
        },
      ],
    },
  };
}

function createProviderRichToolCallEvent(
  eventId = "canonical-rich-tool",
): CanonicalEventsPayload[number] {
  return {
    ...baseEvent,
    eventId,
    seq: 2,
    category: "artifact",
    type: "provider-rich-part",
    richKind: "acp-tool-call",
    payload: {
      toolCallId: "acp-tool-7",
      title: "Read file",
      kind: "read",
      status: "completed",
      locations: [],
      rawInput: "{}",
      progressChunks: [],
    },
  };
}

describe("daemon runtime event commit planning", () => {
  // Delta rows are stamped with `new Date()` deep in the row builders, sampled
  // independently by the agUiEvents and canonicalEvents paths. Without a frozen
  // clock a wall-clock tick between the two builds makes their timestamps differ
  // by 1ms and the deep-equality parity assertion flakes.
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-31T00:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
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

  it("emits a terragon.part row for a provider-rich-part plan carrier and leaves richPartRows empty", () => {
    const plan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [createRichPartMessage()],
      canonicalEventsForPersistence: [
        createRunStartedEvent(),
        createProviderRichPlanEvent(),
      ],
      deltas: null,
      runId: "run-1",
    });

    expect(plan.richPartRows).toEqual([]);
    expect(plan.canonicalRows.map((row) => row.eventId)).toEqual([
      "canonical-start:RUN_STARTED:0",
      "canonical-rich-plan:CUSTOM:0",
    ]);
    const planRow = plan.canonicalRows[1]!;
    expect(planRow.event.type).toBe(EventType.CUSTOM);
    expect(Reflect.get(planRow.event, "name")).toBe("terragon.part");
    expect(Reflect.get(planRow.event, "value")).toEqual({
      richKind: "acp-plan",
      payload: {
        entries: [
          {
            id: "step-1",
            content: "Run tests",
            priority: "medium",
            status: "pending",
          },
        ],
      },
    });
  });

  it("expands an ACP tool-call carrier to tool-call rows keyed on the canonical eventId", () => {
    const plan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [],
      canonicalEventsForPersistence: [createProviderRichToolCallEvent()],
      deltas: null,
      runId: "run-1",
    });

    expect(plan.richPartRows.map((row) => row.eventId)).toEqual([
      "msg:canonical-rich-tool:msg:0:TOOL_CALL_START:0",
      "msg:canonical-rich-tool:msg:0:TOOL_CALL_ARGS:1",
      "msg:canonical-rich-tool:msg:0:TOOL_CALL_END:2",
    ]);
  });

  it("falls back to toDBMessage(messages[]) when the batch carries no provider-rich-part carrier", () => {
    const plan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [createRichPartMessage()],
      canonicalEventsForPersistence: [createRunStartedEvent()],
      deltas: null,
      runId: "run-1",
    });

    expect(plan.richPartRows.map((row) => row.eventId)).toEqual([
      "msg:event-1:msg:0:CUSTOM:0",
    ]);
  });

  it("emits each rich row exactly once from the canonical carrier when a mixed batch also carries messages[]", () => {
    const plan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [createRichPartMessage()],
      canonicalEventsForPersistence: [
        createRunStartedEvent(),
        createProviderRichToolCallEvent(),
      ],
      deltas: null,
      runId: "run-1",
    });

    expect(plan.richPartRows.map((row) => row.eventId)).toEqual([
      "msg:canonical-rich-tool:msg:0:TOOL_CALL_START:0",
      "msg:canonical-rich-tool:msg:0:TOOL_CALL_ARGS:1",
      "msg:canonical-rich-tool:msg:0:TOOL_CALL_END:2",
    ]);
    expect(plan.mergedRows.some((row) => row.eventId.includes("event-1"))).toBe(
      false,
    );
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

  it("persists the same rows whether the batch arrives as agUiEvents or canonicalEvents", () => {
    const canonicalEvents: CanonicalEventsPayload = [
      createRunStartedEvent(),
      createProviderRichPlanEvent(),
      createRunTerminalEvent(),
    ];
    const deltas = [createDelta()];
    const nonTerminal = canonicalEvents.filter(
      (event) => event.type !== "run-terminal",
    );

    const canonicalPlan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [],
      canonicalEventsForPersistence: nonTerminal,
      deltas,
      runId: "run-1",
    });

    const agUiStandardRows = agUiWireRowsToRows(
      buildStandardAgUiWireRows({
        runId: "run-1",
        canonicalEvents,
        deltas,
      }),
    );
    const daemonPlan = buildPreLegacyAgUiCommitPlan({
      canPersistCanonicalEvents: true,
      envelopeV2,
      messages: [],
      canonicalEventsForPersistence: nonTerminal,
      deltas,
      runId: "run-1",
      agUiStandardRows,
    });

    const identity = (rows: typeof canonicalPlan.mergedRows) =>
      rows.map((row) => ({ eventId: row.eventId, event: row.event }));

    expect(identity(daemonPlan.mergedRows)).toEqual(
      identity(canonicalPlan.mergedRows),
    );
    expect(daemonPlan.requiresPersistence).toBe(
      canonicalPlan.requiresPersistence,
    );
    expect(
      agUiStandardRows.some((row) => row.event.type === EventType.RUN_FINISHED),
    ).toBe(false);
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
