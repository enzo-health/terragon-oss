import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { handleHumanAction, normalizeHumanAction } from "./human-interventions";

vi.mock("../../v3/store", () => ({
  appendJournalEvent: vi.fn().mockResolvedValue({ inserted: true, id: "j-1" }),
  enqueueOutboxRecord: vi.fn().mockResolvedValue({ inserted: true, id: "o-1" }),
}));

async function getMocks() {
  const { appendJournalEvent, enqueueOutboxRecord } = await import(
    "../../v3/store"
  );
  return {
    appendJournalEvent: appendJournalEvent as ReturnType<typeof vi.fn>,
    enqueueOutboxRecord: enqueueOutboxRecord as ReturnType<typeof vi.fn>,
  };
}

const fakeDb = {
  insert: vi.fn(),
  transaction: vi.fn(),
} as unknown as DB;
const workflowId = "wf-human" as WorkflowId;

describe("normalizeHumanAction", () => {
  it("maps bypass to a human bypass signal", () => {
    const signal = normalizeHumanAction({
      action: "bypass",
      actorUserId: "user-1",
      gate: "review",
    });
    expect(signal).toEqual({
      source: "human",
      event: {
        kind: "bypass_requested",
        actorUserId: "user-1",
        target: "review",
      },
    });
  });
});

describe("handleHumanAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> };
    tx.transaction.mockImplementation(
      async (fn: (db: DB) => Promise<unknown>) => fn(fakeDb),
    );
  });

  it("writes journal + outbox in one transaction", async () => {
    const { appendJournalEvent, enqueueOutboxRecord } = await getMocks();

    await handleHumanAction({
      db: fakeDb,
      action: "resume",
      actorUserId: "user-1",
      workflowId,
      inboxPartitionKey: workflowId,
      idempotencyKey: "req-1",
    });

    const tx = fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> };
    expect(tx.transaction).toHaveBeenCalledOnce();
    expect(appendJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        source: "human",
        eventType: "resume_requested",
        idempotencyKey: "human:wf-human:resume:req-1",
      }),
    );
    expect(enqueueOutboxRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        outbox: expect.objectContaining({
          workflowId,
          topic: "signal",
          idempotencyKey: "human:wf-human:resume:req-1",
        }),
      }),
    );
  });

  it("does not enqueue outbox when journal insert is deduped", async () => {
    const { appendJournalEvent, enqueueOutboxRecord } = await getMocks();
    appendJournalEvent.mockResolvedValueOnce({ inserted: false, id: null });

    await handleHumanAction({
      db: fakeDb,
      action: "stop",
      actorUserId: "user-1",
      workflowId,
      inboxPartitionKey: workflowId,
      idempotencyKey: "req-2",
    });

    expect(enqueueOutboxRecord).not.toHaveBeenCalled();
  });
});
