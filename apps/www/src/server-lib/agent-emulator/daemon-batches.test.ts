import { CanonicalEventSchema } from "@terragon/agent/canonical-events";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import { describe, expect, it } from "vitest";
import {
  buildDeltaBatch,
  buildMessagesBatch,
  createEmulatorRunState,
} from "./daemon-batches";
import {
  EMULATOR_SCENARIOS,
  resolveEmulatorScenario,
  terminalMessages,
  type EmulatorStep,
} from "./scenarios";
import { runEmulatorStream } from "./run-emulator";

const RUN = {
  runId: "run-emulator-test",
  threadId: "thread-emulator-test",
  threadChatId: "chat-emulator-test",
  timezone: "UTC",
};

function systemInitMessage() {
  return {
    type: "system" as const,
    subtype: "init" as const,
    session_id: "emulator-session",
    tools: ["Bash"],
    mcp_servers: [],
  };
}

function assertValidEnvelope(body: DaemonEventAPIBody, expectedSeq: number) {
  expect(body.payloadVersion).toBe(2);
  expect(body.runId).toBe(RUN.runId);
  expect(body.threadId).toBe(RUN.threadId);
  expect(body.threadChatId).toBe(RUN.threadChatId);
  expect(body.seq).toBe(expectedSeq);
  expect(typeof body.eventId).toBe("string");
  expect(body.eventId!.length).toBeGreaterThan(0);
  expect(body.transportMode).toBe("acp");
  expect(body.protocolVersion).toBe(2);
}

function assertCanonicalEventsValid(events: CanonicalEvent[] | undefined) {
  for (const event of events ?? []) {
    expect(() => CanonicalEventSchema.parse(event)).not.toThrow();
  }
}

describe("agent emulator daemon batches", () => {
  it("emits run-started on the first messages batch with a monotonic envelope seq", () => {
    const state = createEmulatorRunState(RUN);
    const first = buildMessagesBatch(state, [systemInitMessage()]);
    assertValidEnvelope(first, 0);
    assertCanonicalEventsValid(first.canonicalEvents);
    expect(first.canonicalEvents?.[0]?.type).toBe("run-started");

    const second = buildMessagesBatch(state, [systemInitMessage()]);
    assertValidEnvelope(second, 1);
    expect(
      second.canonicalEvents?.some((event) => event.type === "run-started"),
    ).toBe(false);
  });

  it("allocates delta-only envelopes with monotonic delta seqs and distinct event ids", () => {
    const state = createEmulatorRunState(RUN);
    const messages = buildMessagesBatch(state, [systemInitMessage()]);
    const deltaA = buildDeltaBatch(state, [
      { messageId: "m1", partIndex: 0, kind: "text", text: "he" },
    ]);
    const deltaB = buildDeltaBatch(state, [
      { messageId: "m1", partIndex: 0, kind: "text", text: "llo" },
    ]);
    assertValidEnvelope(deltaA, 1);
    assertValidEnvelope(deltaB, 2);
    expect(deltaA.eventId).not.toBe(messages.eventId);
    expect(deltaA.eventId).not.toBe(deltaB.eventId);
    expect(deltaA.deltas?.[0]?.deltaSeq).toBe(0);
    expect(deltaB.deltas?.[0]?.deltaSeq).toBe(1);
    expect(deltaA.deltas?.[0]?.kind).toBe("text");
    expect(deltaA.messages).toEqual([]);
  });

  it("threads tool-call lifecycle canonical events", () => {
    const state = createEmulatorRunState(RUN);
    buildMessagesBatch(state, [systemInitMessage()]);
    const start = buildMessagesBatch(state, [
      {
        type: "assistant",
        parent_tool_use_id: null,
        session_id: "emulator-session",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { a: 1 } },
          ],
        },
      },
    ]);
    assertCanonicalEventsValid(start.canonicalEvents);
    const startEvent = start.canonicalEvents?.find(
      (event) => event.type === "tool-call-start",
    );
    expect(startEvent).toMatchObject({ toolCallId: "tool-1", name: "Bash" });

    const result = buildMessagesBatch(state, [
      {
        type: "user",
        parent_tool_use_id: null,
        session_id: "emulator-session",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
        },
      },
    ]);
    const resultEvent = result.canonicalEvents?.find(
      (event) => event.type === "tool-call-result",
    );
    expect(resultEvent).toMatchObject({ toolCallId: "tool-1" });
  });

  it("stamps a recoverable rate-limit terminal on the run-terminal event", () => {
    const state = createEmulatorRunState(RUN);
    buildMessagesBatch(state, [systemInitMessage()]);
    const resetTimeSec = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const terminal = buildMessagesBatch(
      state,
      terminalMessages({ kind: "rate-limit", resetTimeSec }),
    );
    assertCanonicalEventsValid(terminal.canonicalEvents);
    const runTerminal = terminal.canonicalEvents?.find(
      (event) => event.type === "run-terminal",
    );
    expect(runTerminal).toBeDefined();
    expect(runTerminal).toMatchObject({
      recoverable: { kind: "rate-limit" },
    });
  });

  it("stamps failed/oauth/context terminals correctly", () => {
    const failedState = createEmulatorRunState(RUN);
    buildMessagesBatch(failedState, [systemInitMessage()]);
    const failed = buildMessagesBatch(
      failedState,
      terminalMessages({ kind: "failed", errorInfo: "boom" }),
    );
    const failedTerminal = failed.canonicalEvents?.find(
      (event) => event.type === "run-terminal",
    );
    expect(failedTerminal).toMatchObject({
      status: "failed",
      errorMessage: "boom",
    });

    const oauthState = createEmulatorRunState(RUN);
    buildMessagesBatch(oauthState, [systemInitMessage()]);
    const oauth = buildMessagesBatch(
      oauthState,
      terminalMessages({ kind: "oauth-revoked" }),
    );
    expect(
      oauth.canonicalEvents?.find((event) => event.type === "run-terminal"),
    ).toMatchObject({ recoverable: { kind: "oauth-token-revoked" } });

    const contextState = createEmulatorRunState(RUN);
    buildMessagesBatch(contextState, [systemInitMessage()]);
    const context = buildMessagesBatch(
      contextState,
      terminalMessages({ kind: "context-exhausted" }),
    );
    expect(
      context.canonicalEvents?.find((event) => event.type === "run-terminal"),
    ).toMatchObject({ recoverable: { kind: "context-exhausted" } });
  });
});

describe("agent emulator scenarios", () => {
  it("exposes the documented scenario set", () => {
    expect([...EMULATOR_SCENARIOS.keys()].sort()).toEqual(
      [
        "context-exhausted",
        "default",
        "error",
        "long-stream",
        "oauth-revoked",
        "rate-limit",
        "stopped",
      ].sort(),
    );
  });

  it("selects scenarios from a /emulate prefix and echoes the prompt", () => {
    const fallback = resolveEmulatorScenario("hello there");
    expect(fallback.scenario.name).toBe("default");
    expect(fallback.prompt).toBe("hello there");

    const explicit = resolveEmulatorScenario("/emulate long-stream do a thing");
    expect(explicit.scenario.name).toBe("long-stream");
    expect(explicit.prompt).toBe("do a thing");

    const unknown = resolveEmulatorScenario("/emulate nope still runs");
    expect(unknown.scenario.name).toBe("default");
  });

  it("every scenario ends on exactly one terminal step and echoes the prompt", () => {
    for (const scenario of EMULATOR_SCENARIOS.values()) {
      const steps = scenario.build('review "the-file.ts" now');
      const terminals = steps.filter(
        (step: EmulatorStep) => step.type === "terminal",
      );
      expect(terminals).toHaveLength(1);
      expect(steps[steps.length - 1]!.type).toBe("terminal");
      const echoed = steps.some(
        (step) =>
          (step.type === "text" || step.type === "thinking") &&
          step.text.includes("the-file.ts"),
      );
      expect(echoed).toBe(true);
    }
  });
});

describe("runEmulatorStream export", () => {
  it("is a function", () => {
    expect(typeof runEmulatorStream).toBe("function");
  });
});
