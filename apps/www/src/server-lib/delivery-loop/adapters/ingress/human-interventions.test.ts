import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { handleHumanAction, normalizeHumanAction } from "./human-interventions";

vi.mock("@terragon/shared/delivery-loop/store/signal-inbox-store", () => ({
  appendSignalToInbox: vi.fn().mockResolvedValue({ id: "sig-1" }),
}));

vi.mock("../../v3/store", () => ({
  appendJournalEventV3: vi
    .fn()
    .mockResolvedValue({ inserted: true, id: "j-1" }),
  enqueueOutboxRecordV3: vi
    .fn()
    .mockResolvedValue({ inserted: true, id: "o-1" }),
}));

async function getMocks() {
  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );
  const { appendJournalEventV3, enqueueOutboxRecordV3 } = await import(
    "../../v3/store"
  );
  return {
    appendSignalToInbox: appendSignalToInbox as ReturnType<typeof vi.fn>,
    appendJournalEventV3: appendJournalEventV3 as ReturnType<typeof vi.fn>,
    enqueueOutboxRecordV3: enqueueOutboxRecordV3 as ReturnType<typeof vi.fn>,
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

  it("writes signal inbox + journal + outbox in one transaction", async () => {
    const { appendSignalToInbox, appendJournalEventV3, enqueueOutboxRecordV3 } =
      await getMocks();
    const wakeCoordinator = vi.fn().mockResolvedValue(undefined);

    await handleHumanAction({
      db: fakeDb,
      action: "resume",
      actorUserId: "user-1",
      workflowId,
      inboxPartitionKey: workflowId,
      idempotencyKey: "req-1",
      wakeCoordinator,
    });

    const tx = fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> };
    expect(tx.transaction).toHaveBeenCalledOnce();
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
    expect(appendJournalEventV3).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        source: "human",
        eventType: "resume_requested",
        idempotencyKey: "human:wf-human:resume:req-1",
      }),
    );
    expect(enqueueOutboxRecordV3).toHaveBeenCalledWith(
      expect.objectContaining({
        outbox: expect.objectContaining({
          workflowId,
          topic: "signal",
          idempotencyKey: "human:wf-human:resume:req-1",
        }),
      }),
    );
    expect(wakeCoordinator).toHaveBeenCalledWith(workflowId);
  });

  it("does not enqueue outbox when journal insert is deduped", async () => {
    const { appendJournalEventV3, enqueueOutboxRecordV3 } = await getMocks();
    appendJournalEventV3.mockResolvedValueOnce({ inserted: false, id: null });

    await handleHumanAction({
      db: fakeDb,
      action: "stop",
      actorUserId: "user-1",
      workflowId,
      inboxPartitionKey: workflowId,
      idempotencyKey: "req-2",
    });

    expect(enqueueOutboxRecordV3).not.toHaveBeenCalled();
  });
});
