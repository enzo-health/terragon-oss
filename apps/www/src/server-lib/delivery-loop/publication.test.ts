import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOctokitForApp } from "@/lib/github";
import {
  acquireSdlcLoopLease,
  claimNextSdlcOutboxActionForExecution,
  clearSdlcCanonicalStatusCommentReference,
  completeSdlcOutboxActionExecution,
  evaluateSdlcLoopGuardrails,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
  releaseSdlcLoopLease,
} from "@terragon/shared/model/sdlc-loop";

vi.mock("@/lib/github", () => ({
  getOctokitForApp: vi.fn(),
  parseRepoFullName: (repoFullName: string) => repoFullName.split("/"),
}));

vi.mock("@terragon/env/next-public", () => ({
  publicAppUrl: vi.fn(() => "https://terragon.example"),
}));

vi.mock("@terragon/shared/model/sdlc-loop", () => ({
  acquireSdlcLoopLease: vi.fn(),
  claimNextSdlcOutboxActionForExecution: vi.fn(),
  completeSdlcOutboxActionExecution: vi.fn(),
  evaluateSdlcLoopGuardrails: vi.fn(),
  persistSdlcCanonicalStatusCommentReference: vi.fn(),
  clearSdlcCanonicalStatusCommentReference: vi.fn(),
  persistSdlcCanonicalCheckRunReference: vi.fn(),
  releaseSdlcLoopLease: vi.fn(),
}));

const makeDb = (loop: Record<string, unknown>) =>
  ({
    query: {
      sdlcLoop: {
        findFirst: vi.fn().mockResolvedValue(loop),
      },
    },
  }) as any;

let publicationModule: typeof import("./publication");

describe("sdlc publication", () => {
  beforeEach(async () => {
    if (!publicationModule) {
      publicationModule = await import("./publication");
    }
    vi.clearAllMocks();
    vi.mocked(acquireSdlcLoopLease).mockResolvedValue({
      acquired: true,
      leaseOwner: "worker-1",
      leaseEpoch: 1,
      leaseExpiresAt: new Date("2026-01-01T00:00:30.000Z"),
    });
    vi.mocked(evaluateSdlcLoopGuardrails).mockReturnValue({ allowed: true });
    vi.mocked(releaseSdlcLoopLease).mockResolvedValue(true);
  });

  it("updates canonical status comment in-place when persisted comment exists", async () => {
    const octokit = {
      rest: {
        issues: {
          updateComment: vi.fn().mockResolvedValue({
            data: { id: 123, node_id: "NODE_123" },
          }),
          createComment: vi.fn(),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);

    const result = await publicationModule.upsertSdlcCanonicalStatusComment({
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
          listComments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);

    const result = await publicationModule.upsertSdlcCanonicalStatusComment({
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

  it("reconciles canonical status comment before create to avoid duplicate side effects after DB persistence failure", async () => {
    const loopId = "loop-status-reconcile";
    const marker = `<!-- terragon-sdlc-loop-status-comment:${loopId} -->`;
    const octokit = {
      rest: {
        issues: {
          updateComment: vi.fn().mockResolvedValue({
            data: { id: 900, node_id: "NODE_900" },
          }),
          createComment: vi.fn().mockResolvedValue({
            data: { id: 900, node_id: "NODE_900" },
          }),
          listComments: vi
            .fn()
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({
              data: [{ id: 900, node_id: "NODE_900", body: marker }],
            }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);
    vi.mocked(persistSdlcCanonicalStatusCommentReference)
      .mockRejectedValueOnce(new Error("transient db failure"))
      .mockResolvedValue(undefined);

    await expect(
      publicationModule.upsertSdlcCanonicalStatusComment({
        db: makeDb({ id: loopId, canonicalStatusCommentId: null }),
        loopId,
        repoFullName: "owner/repo",
        prNumber: 5,
        body: "status body",
      }),
    ).rejects.toThrow("transient db failure");

    const recovered = await publicationModule.upsertSdlcCanonicalStatusComment({
      db: makeDb({ id: loopId, canonicalStatusCommentId: null }),
      loopId,
      repoFullName: "owner/repo",
      prNumber: 5,
      body: "status body",
    });

    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({
      commentId: "900",
      wasCreated: false,
    });
  });

  it("updates canonical check summary and includes Terragon task link instead of direct artifact URL", async () => {
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

    await publicationModule.upsertSdlcCanonicalCheckSummary({
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
        external_id: "terragon-sdlc-loop-check-run:loop-3",
        output: expect.objectContaining({
          summary: expect.stringContaining("https://terragon.example/task/"),
        }),
      }),
    );
    expect(persistSdlcCanonicalCheckRunReference).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: "loop-3", checkRunId: 321 }),
    );
  });

  it("reconciles canonical check run before create to avoid duplicate side effects after DB persistence failure", async () => {
    const loopId = "loop-check-reconcile";
    const octokit = {
      rest: {
        checks: {
          update: vi.fn().mockResolvedValue({
            data: { id: 601 },
          }),
          create: vi.fn().mockResolvedValue({
            data: { id: 601 },
          }),
          listForRef: vi
            .fn()
            .mockResolvedValueOnce({ data: { check_runs: [] } })
            .mockResolvedValueOnce({
              data: {
                check_runs: [
                  {
                    id: 601,
                    external_id: `terragon-sdlc-loop-check-run:${loopId}`,
                  },
                ],
              },
            }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              head: { sha: "abc123" },
            },
          }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);
    vi.mocked(persistSdlcCanonicalCheckRunReference)
      .mockRejectedValueOnce(new Error("transient db failure"))
      .mockResolvedValue(undefined);

    await expect(
      publicationModule.upsertSdlcCanonicalCheckSummary({
        db: makeDb({
          id: loopId,
          threadId: "thread-9",
          canonicalCheckRunId: null,
        }),
        loopId,
        payload: {
          repoFullName: "owner/repo",
          prNumber: 9,
          title: "Terragon SDLC Loop",
          summary: "Gate summary",
          status: "completed",
          conclusion: "success",
        },
      }),
    ).rejects.toThrow("transient db failure");

    const recovered = await publicationModule.upsertSdlcCanonicalCheckSummary({
      db: makeDb({
        id: loopId,
        threadId: "thread-9",
        canonicalCheckRunId: null,
      }),
      loopId,
      payload: {
        repoFullName: "owner/repo",
        prNumber: 9,
        title: "Terragon SDLC Loop",
        summary: "Gate summary",
        status: "completed",
        conclusion: "success",
      },
    });

    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({
      checkRunId: 601,
      wasCreated: false,
    });
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
          listComments: vi.fn().mockResolvedValue({ data: [] }),
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

    const result =
      await publicationModule.executeNextSdlcOutboxPublicationAction({
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

  it("runs best-effort coordinator publication under lease and releases it", async () => {
    vi.mocked(claimNextSdlcOutboxActionForExecution).mockResolvedValue(null);

    const result =
      await publicationModule.runBestEffortSdlcPublicationCoordinator({
        db: makeDb({ id: "loop-coordinator", state: "enrolled" }),
        loopId: "loop-coordinator",
        leaseOwnerToken: "daemon-event:event-1:2",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });

    expect(result).toEqual({
      executed: false,
      reason: "no_eligible_action",
    });
    expect(acquireSdlcLoopLease).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop-coordinator",
      }),
    );
    expect(evaluateSdlcLoopGuardrails).toHaveBeenCalledWith(
      expect.objectContaining({
        hasValidLease: true,
        isTerminalState: false,
      }),
    );
    expect(releaseSdlcLoopLease).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop-coordinator",
      }),
    );
  });

  it("durably drains due outbox actions with bounded action limits", async () => {
    const selectLimit = vi
      .fn()
      .mockResolvedValue([{ loopId: "loop-1" }, { loopId: "loop-2" }]);
    const selectOrderBy = vi.fn(() => ({
      limit: selectLimit,
    }));
    const selectGroupBy = vi.fn(() => ({
      orderBy: selectOrderBy,
    }));
    const selectWhere = vi.fn(() => ({
      groupBy: selectGroupBy,
    }));
    const selectInnerJoin = vi.fn(() => ({
      where: selectWhere,
    }));
    const selectFrom = vi.fn(() => ({
      innerJoin: selectInnerJoin,
    }));
    const select = vi.fn(() => ({
      from: selectFrom,
    }));

    const db = {
      ...makeDb({
        id: "loop-1",
        state: "enrolled",
        loopVersion: 1,
        canonicalStatusCommentId: null,
      }),
      select,
    } as any;

    vi.mocked(claimNextSdlcOutboxActionForExecution)
      .mockResolvedValueOnce({
        id: "outbox-1",
        loopId: "loop-1",
        transitionSeq: 1,
        actionType: "publish_status_comment",
        supersessionGroup: "publication_status",
        actionKey: "status-1",
        payload: {
          repoFullName: "owner/repo",
          prNumber: 1,
          body: "first",
        },
        attemptCount: 1,
      })
      .mockResolvedValueOnce({
        id: "outbox-2",
        loopId: "loop-1",
        transitionSeq: 2,
        actionType: "publish_status_comment",
        supersessionGroup: "publication_status",
        actionKey: "status-2",
        payload: {
          repoFullName: "owner/repo",
          prNumber: 1,
          body: "second",
        },
        attemptCount: 1,
      });

    const octokit = {
      rest: {
        issues: {
          updateComment: vi.fn(),
          createComment: vi.fn().mockResolvedValue({
            data: { id: 101, node_id: "NODE_101" },
          }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as any);
    vi.mocked(completeSdlcOutboxActionExecution).mockResolvedValue({
      updated: true,
      status: "completed",
      retryAt: null,
      attempt: 1,
    });

    const result = await publicationModule.drainDueSdlcPublicationOutboxActions(
      {
        db,
        leaseOwnerTokenPrefix: "cron:scheduled-tasks",
        maxLoops: 2,
        maxActionsTotal: 2,
        maxActionsPerLoop: 5,
      },
    );

    expect(result).toEqual({
      dueLoopCount: 2,
      visitedLoopCount: 1,
      loopsWithExecutedActions: 1,
      executedActionCount: 2,
      reachedActionLimit: true,
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(claimNextSdlcOutboxActionForExecution).toHaveBeenCalledTimes(2);
  });

  it("returns empty drain summary when no due loops exist", async () => {
    const selectLimit = vi.fn().mockResolvedValue([]);
    const selectOrderBy = vi.fn(() => ({
      limit: selectLimit,
    }));
    const selectGroupBy = vi.fn(() => ({
      orderBy: selectOrderBy,
    }));
    const selectWhere = vi.fn(() => ({
      groupBy: selectGroupBy,
    }));
    const selectInnerJoin = vi.fn(() => ({
      where: selectWhere,
    }));
    const selectFrom = vi.fn(() => ({
      innerJoin: selectInnerJoin,
    }));
    const select = vi.fn(() => ({
      from: selectFrom,
    }));

    const db = {
      ...makeDb({
        id: "loop-1",
        state: "enrolled",
        loopVersion: 1,
        canonicalStatusCommentId: null,
      }),
      select,
    } as any;

    const result = await publicationModule.drainDueSdlcPublicationOutboxActions(
      {
        db,
        leaseOwnerTokenPrefix: "cron:scheduled-tasks",
        maxLoops: 5,
        maxActionsTotal: 10,
        maxActionsPerLoop: 2,
      },
    );

    expect(result).toEqual({
      dueLoopCount: 0,
      visitedLoopCount: 0,
      loopsWithExecutedActions: 0,
      executedActionCount: 0,
      reachedActionLimit: false,
    });
    expect(claimNextSdlcOutboxActionForExecution).not.toHaveBeenCalled();
  });

  it("passes runtime guardrail inputs into publication evaluation", async () => {
    vi.mocked(claimNextSdlcOutboxActionForExecution).mockResolvedValue(null);
    const cooldownUntil = new Date("2026-01-01T00:05:00.000Z");

    await publicationModule.runBestEffortSdlcPublicationCoordinator({
      db: makeDb({
        id: "loop-guardrails",
        state: "enrolled",
        loopVersion: 8,
      }),
      loopId: "loop-guardrails",
      leaseOwnerToken: "daemon-event:event-1:guardrails",
      guardrailRuntime: {
        killSwitchEnabled: false,
        cooldownUntil,
        maxIterations: 12,
        manualIntentAllowed: true,
        iterationCount: 6,
      },
    });

    expect(evaluateSdlcLoopGuardrails).toHaveBeenCalledWith(
      expect.objectContaining({
        killSwitchEnabled: false,
        cooldownUntil,
        maxIterations: 12,
        manualIntentAllowed: true,
        iterationCount: 6,
      }),
    );
  });

  it("skips best-effort publication when loop is terminal", async () => {
    const result =
      await publicationModule.runBestEffortSdlcPublicationCoordinator({
        db: makeDb({ id: "loop-terminal", state: "done" }),
        loopId: "loop-terminal",
        leaseOwnerToken: "daemon-event:event-1:3",
      });

    expect(result).toEqual({
      executed: false,
      reason: "terminal_state",
    });
    expect(acquireSdlcLoopLease).not.toHaveBeenCalled();
  });

  it("classifies publication errors into retry policy classes", () => {
    expect(
      publicationModule.classifySdlcPublicationFailure({ status: 429 })
        .errorClass,
    ).toBe("quota");
    expect(
      publicationModule.classifySdlcPublicationFailure({ status: 403 })
        .retriable,
    ).toBe(false);
    expect(
      publicationModule.classifySdlcPublicationFailure({ status: 502 })
        .retriable,
    ).toBe(true);
  });
});
