import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOctokitForApp } from "@/lib/github";
import {
  clearSdlcCanonicalStatusCommentReference,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
} from "@terragon/shared/model/delivery-loop";

vi.mock("@/lib/github", () => ({
  getOctokitForApp: vi.fn(),
  parseRepoFullName: (repoFullName: string) => repoFullName.split("/"),
}));

vi.mock("@terragon/env/next-public", () => ({
  publicAppUrl: vi.fn(() => "https://terragon.example"),
}));

vi.mock("@terragon/shared/model/delivery-loop", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/delivery-loop")
    >();
  return {
    ...actual,
    persistSdlcCanonicalStatusCommentReference: vi.fn(),
    clearSdlcCanonicalStatusCommentReference: vi.fn(),
    persistSdlcCanonicalCheckRunReference: vi.fn(),
  };
});

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
          title: "Terragon Delivery Loop",
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
        title: "Terragon Delivery Loop",
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
