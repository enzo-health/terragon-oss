import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  handleGitHubWebhook,
  normalizeGitHubWebhook,
  type GitHubWebhookPayload,
} from "./github-ingress";

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
const workflowId = "wf-gh" as WorkflowId;

function baseEvent(
  overrides: Partial<GitHubWebhookPayload> = {},
): GitHubWebhookPayload {
  return {
    action: "check_run_completed",
    prNumber: 17,
    repoFullName: "acme/widgets",
    checkRunId: "cr-1",
    checkName: "build",
    checkConclusion: "success",
    ...overrides,
  };
}

describe("normalizeGitHubWebhook", () => {
  it("ignores non-actionable review events", () => {
    const signal = normalizeGitHubWebhook(
      baseEvent({
        action: "pull_request_review",
        reviewState: "commented",
      }),
    );
    expect(signal).toBeNull();
  });
});

describe("handleGitHubWebhook", () => {
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
    const lookupWorkflowByPr = vi.fn().mockResolvedValue(workflowId);
    const wakeCoordinator = vi.fn().mockResolvedValue(undefined);

    await handleGitHubWebhook({
      db: fakeDb,
      rawEvent: baseEvent(),
      inboxPartitionKey: workflowId,
      lookupWorkflowByPr,
      wakeCoordinator,
    });

    const tx = fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> };
    expect(tx.transaction).toHaveBeenCalledOnce();
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
    expect(appendJournalEventV3).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        source: "github",
        eventType: "ci_changed",
        idempotencyKey: "github:acme/widgets:17:check_run_completed:cr-1",
      }),
    );
    expect(enqueueOutboxRecordV3).toHaveBeenCalledWith(
      expect.objectContaining({
        outbox: expect.objectContaining({
          workflowId,
          topic: "signal",
          idempotencyKey: "github:acme/widgets:17:check_run_completed:cr-1",
        }),
      }),
    );
    expect(wakeCoordinator).toHaveBeenCalledWith(workflowId);
  });

  it("does not enqueue outbox when journal insert is deduped", async () => {
    const { appendJournalEventV3, enqueueOutboxRecordV3 } = await getMocks();
    appendJournalEventV3.mockResolvedValueOnce({ inserted: false, id: null });
    const lookupWorkflowByPr = vi.fn().mockResolvedValue(workflowId);

    await handleGitHubWebhook({
      db: fakeDb,
      rawEvent: baseEvent(),
      inboxPartitionKey: workflowId,
      lookupWorkflowByPr,
    });

    expect(enqueueOutboxRecordV3).not.toHaveBeenCalled();
  });

  it("no-ops when no active workflow is found", async () => {
    const { appendSignalToInbox, appendJournalEventV3, enqueueOutboxRecordV3 } =
      await getMocks();
    const lookupWorkflowByPr = vi.fn().mockResolvedValue(null);

    await handleGitHubWebhook({
      db: fakeDb,
      rawEvent: baseEvent(),
      inboxPartitionKey: "loop-legacy",
      lookupWorkflowByPr,
    });

    expect(appendSignalToInbox).not.toHaveBeenCalled();
    expect(appendJournalEventV3).not.toHaveBeenCalled();
    expect(enqueueOutboxRecordV3).not.toHaveBeenCalled();
  });
});
