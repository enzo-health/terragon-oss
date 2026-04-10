import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@leo/shared";
import {
  allThreadStatuses,
  allDeprecatedThreadStatuses,
} from "./thread-status";
import { createActor } from "xstate";
import { machine as threadMachine } from "./machine";

describe("threadMachine", () => {
  it("should queue from the draft state", () => {
    const actor = createActor(threadMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.draft" });
    expect(actor.getSnapshot().value).toBe("draft");
    actor.send({ type: "user.queue" });
    expect(actor.getSnapshot().value).toBe("queued");
  });

  it("should start in the queued state", () => {
    const actor = createActor(threadMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe("queued");
  });

  it("happy path from queued to complete", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "assistant.message" });
    expect(actor.getSnapshot().value).toBe("working");
    actor.send({ type: "assistant.message_done" });
    expect(actor.getSnapshot().value).toBe("working-done");
    actor.send({ type: "system.checkpoint" });
    expect(actor.getSnapshot().value).toBe("checkpointing");
    actor.send({ type: "system.checkpoint-done" });
    expect(actor.getSnapshot().value).toBe("complete");
  });

  it("user stop mid-working", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "assistant.message" });
    expect(actor.getSnapshot().value).toBe("working");
    actor.send({ type: "user.stop" });
    expect(actor.getSnapshot().value).toBe("stopping");
    actor.send({ type: "assistant.message_stop" });
    expect(actor.getSnapshot().value).toBe("complete");
  });

  it("assistant error mid-working", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "assistant.message" });
    expect(actor.getSnapshot().value).toBe("working");
    actor.send({ type: "assistant.message_error" });
    expect(actor.getSnapshot().value).toBe("working-error");
    actor.send({ type: "system.checkpoint" });
    expect(actor.getSnapshot().value).toBe("checkpointing");
    actor.send({ type: "system.checkpoint-done" });
    expect(actor.getSnapshot().value).toBe("complete");
  });

  it("stop while booting", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "user.stop" });
    expect(actor.getSnapshot().value).toBe("stopping");
    actor.send({ type: "system.stop" });
    expect(actor.getSnapshot().value).toBe("complete");
  });

  it("first message is final message - booting to working-done", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    // First assistant message is also the final message
    actor.send({ type: "assistant.message_done" });
    expect(actor.getSnapshot().value).toBe("working-done");
    actor.send({ type: "system.checkpoint" });
    expect(actor.getSnapshot().value).toBe("checkpointing");
    actor.send({ type: "system.checkpoint-done" });
    expect(actor.getSnapshot().value).toBe("complete");
  });

  it("agent rate limit from booting state", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "system.agent-rate-limit" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "system.checkpoint" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "system.checkpoint-done" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "system.resume" });
    expect(actor.getSnapshot().value).toBe("queued");
  });

  it("agent rate limit from working state", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "assistant.message" });
    expect(actor.getSnapshot().value).toBe("working");
    actor.send({ type: "system.agent-rate-limit" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "system.checkpoint" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "system.checkpoint-done" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "system.resume" });
    expect(actor.getSnapshot().value).toBe("queued");
  });

  it("concurrency limit from booting requeues to queued-tasks-concurrency", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "system.concurrency-limit" });
    expect(actor.getSnapshot().value).toBe("queued-tasks-concurrency");
    actor.send({ type: "system.resume" });
    expect(actor.getSnapshot().value).toBe("queued");
  });

  it("user stop while in rate limit queue", () => {
    const actor = createActor(threadMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe("queued");
    actor.send({ type: "system.boot" });
    expect(actor.getSnapshot().value).toBe("booting");
    actor.send({ type: "assistant.message" });
    expect(actor.getSnapshot().value).toBe("working");
    actor.send({ type: "system.agent-rate-limit" });
    expect(actor.getSnapshot().value).toBe("queued-agent-rate-limit");
    actor.send({ type: "user.stop" });
    expect(actor.getSnapshot().value).toBe("complete");
  });
});

describe("Thread Status Machine Consistency", () => {
  it("should have all machine states match expected thread statuses", () => {
    const machineStates = Object.keys(threadMachine.states);
    const allStatuses = Object.keys(allThreadStatuses) as ThreadStatus[];
    const allDeprecatedStatuses = Object.keys(allDeprecatedThreadStatuses);

    // Check that all machine states are valid thread statuses
    for (const state of machineStates) {
      expect(allStatuses).toContain(state as ThreadStatus);
    }

    // Get active (non-deprecated) thread statuses
    const activeThreadStatuses = allStatuses.filter(
      (status) => !allDeprecatedStatuses.includes(status),
    );
    // Check that all active thread statuses have corresponding machine states
    for (const status of activeThreadStatuses) {
      expect(machineStates).toContain(status);
    }
  });
});
