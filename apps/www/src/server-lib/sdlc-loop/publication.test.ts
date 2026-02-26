import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySdlcPublicationFailure,
  executeNextSdlcOutboxPublicationAction,
  upsertSdlcCanonicalCheckSummary,
  upsertSdlcCanonicalStatusComment,
} from "./publication";
import { getOctokitForApp } from "@/lib/github";
import { r2Private } from "@/server-lib/r2";
import {
  claimNextSdlcOutboxActionForExecution,
  clearSdlcCanonicalStatusCommentReference,
  completeSdlcOutboxActionExecution,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
} from "@terragon/shared/model/sdlc-loop";

vi.mock("@/lib/github", () => ({
  getOctokitForApp: vi.fn(),
  parseRepoFullName: (repoFullName: string) => repoFullName.split("/"),
}));

vi.mock("@/server-lib/r2", () => ({
  r2Private: {
    generatePresignedDownloadUrl: vi.fn(),
  },
}));

vi.mock("@terragon/shared/model/sdlc-loop", () => ({
  claimNextSdlcOutboxActionForExecution: vi.fn(),
  completeSdlcOutboxActionExecution: vi.fn(),
  persistSdlcCanonicalStatusCommentReference: vi.fn(),
  clearSdlcCanonicalStatusCommentReference: vi.fn(),
  persistSdlcCanonicalCheckRunReference: vi.fn(),
}));

const makeDb = (loop: Record<string, unknown>) =>
  ({
    query: {
      sdlcLoop: {
        findFirst: vi.fn().mockResolvedValue(loop),
      },
    },
  }) as any;

describe("sdlc publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates canonical status comment in-place when persisted comment exists", async () => {
    const octokit = {
      rest: {
        issues: {
          updateComment: vi.fn().mockResolvedValue({
            data: { id: 123, node_id: "NODE_123" },
          }),
          createComment: vi.fn(),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);

    const result = await upsertSdlcCanonicalStatusComment({
      db: makeDb({ id: "loop-1", canonicalStatusCommentId: "123" }),
      loopId: "loop-1",
      repoFullName: "owner/repo",
      prNumber: 1,
      body: "updated",
    });

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(persistSdlcCanonicalStatusCommentReference).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop-1",
        commentId: "123",
      }),
    );
    expect(result.wasCreated).toBe(false);
  });

  it("recreates canonical status comment once when persisted comment is missing", async () => {
    const octokit = {
      rest: {
        issues: {
          updateComment: vi.fn().mockRejectedValue({ status: 404 }),
          createComment: vi.fn().mockResolvedValue({
            data: { id: 777, node_id: "NODE_777" },
          }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);

    const result = await upsertSdlcCanonicalStatusComment({
      db: makeDb({ id: "loop-2", canonicalStatusCommentId: "456" }),
      loopId: "loop-2",
      repoFullName: "owner/repo",
      prNumber: 2,
      body: "recreated",
    });

    expect(clearSdlcCanonicalStatusCommentReference).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: "loop-2" }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(result.wasCreated).toBe(true);
    expect(result.wasRecreatedAfterMissing).toBe(true);
  });

  it("updates canonical check summary and includes short-lived artifact link", async () => {
    vi.mocked(r2Private.generatePresignedDownloadUrl).mockResolvedValue(
      "https://signed.example/video",
    );

    const octokit = {
      rest: {
        checks: {
          update: vi.fn().mockResolvedValue({}),
          create: vi.fn(),
        },
        pulls: {
          get: vi.fn(),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);

    await upsertSdlcCanonicalCheckSummary({
      db: makeDb({ id: "loop-3", canonicalCheckRunId: 321 }),
      loopId: "loop-3",
      payload: {
        repoFullName: "owner/repo",
        prNumber: 3,
        title: "SDLC",
        summary: "All gates passed",
        status: "completed",
        conclusion: "success",
        artifactR2Key: "videos/loop-3.mp4",
      },
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 321,
        output: expect.objectContaining({
          summary: expect.stringContaining("Session video artifact"),
        }),
      }),
    );
    expect(persistSdlcCanonicalCheckRunReference).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: "loop-3", checkRunId: 321 }),
    );
  });

  it("completes outbox action with retriable failure classification on upstream errors", async () => {
    vi.mocked(claimNextSdlcOutboxActionForExecution).mockResolvedValue({
      id: "outbox-1",
      loopId: "loop-4",
      transitionSeq: 1,
      actionType: "publish_status_comment",
      supersessionGroup: "publication_status",
      actionKey: "status-1",
      payload: {
        repoFullName: "owner/repo",
        prNumber: 4,
        body: "status",
      },
      attemptCount: 1,
    });

    const octokit = {
      rest: {
        issues: {
          createComment: vi.fn().mockRejectedValue({ status: 502 }),
          updateComment: vi.fn(),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);
    vi.mocked(completeSdlcOutboxActionExecution).mockResolvedValue({
      updated: true,
      status: "pending",
      retryAt: new Date("2026-01-01T00:01:00.000Z"),
      attempt: 1,
    });

    const result = await executeNextSdlcOutboxPublicationAction({
      db: makeDb({ id: "loop-4", canonicalStatusCommentId: null }),
      loopId: "loop-4",
      leaseOwner: "worker-1",
      leaseEpoch: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.executed).toBe(true);
    expect(completeSdlcOutboxActionExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId: "outbox-1",
        retriable: true,
        errorClass: "infra",
        errorCode: "github_upstream_5xx",
      }),
    );
  });

  it("classifies publication errors into retry policy classes", () => {
    expect(classifySdlcPublicationFailure({ status: 429 }).errorClass).toBe(
      "quota",
    );
    expect(classifySdlcPublicationFailure({ status: 403 }).retriable).toBe(
      false,
    );
    expect(classifySdlcPublicationFailure({ status: 502 }).retriable).toBe(
      true,
    );
  });
});
