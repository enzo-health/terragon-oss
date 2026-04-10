import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOctokitForApp } from "@/lib/github";
import {
  persistWorkflowStatusCommentReference,
  clearWorkflowStatusCommentReference,
  persistWorkflowCheckRunReference,
} from "@leo/shared/delivery-loop/store/workflow-github-refs";

vi.mock("@/lib/github", () => ({
  getOctokitForApp: vi.fn(),
  parseRepoFullName: (repoFullName: string) => repoFullName.split("/"),
}));

vi.mock("@leo/env/next-public", () => ({
  publicAppUrl: vi.fn(() => "https://leo.example"),
}));

vi.mock("@leo/shared/delivery-loop/store/workflow-github-refs", () => ({
  persistWorkflowStatusCommentReference: vi.fn(),
  clearWorkflowStatusCommentReference: vi.fn(),
  persistWorkflowCheckRunReference: vi.fn(),
}));

const makeDb = (workflow: Record<string, unknown>) =>
  ({
    query: {
      deliveryWorkflow: {
        findFirst: vi.fn().mockResolvedValue(workflow),
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

    const result = await publicationModule.upsertDeliveryCanonicalStatusComment(
      {
        db: makeDb({ id: "wf-1", canonicalStatusCommentId: "123" }),
        workflowId: "wf-1",
        repoFullName: "owner/repo",
        prNumber: 1,
        body: "updated",
      },
    );

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(persistWorkflowStatusCommentReference).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
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

    const result = await publicationModule.upsertDeliveryCanonicalStatusComment(
      {
        db: makeDb({ id: "wf-2", canonicalStatusCommentId: "456" }),
        workflowId: "wf-2",
        repoFullName: "owner/repo",
        prNumber: 2,
        body: "recreated",
      },
    );

    expect(clearWorkflowStatusCommentReference).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf-2" }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(result.wasCreated).toBe(true);
    expect(result.wasRecreatedAfterMissing).toBe(true);
  });

  it("reconciles canonical status comment before create to avoid duplicate side effects after DB persistence failure", async () => {
    const workflowId = "wf-status-reconcile";
    const marker = `<!-- leo-sdlc-loop-status-comment:${workflowId} -->`;
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
    vi.mocked(persistWorkflowStatusCommentReference)
      .mockRejectedValueOnce(new Error("transient db failure"))
      .mockResolvedValue(undefined);

    await expect(
      publicationModule.upsertDeliveryCanonicalStatusComment({
        db: makeDb({ id: workflowId, canonicalStatusCommentId: null }),
        workflowId,
        repoFullName: "owner/repo",
        prNumber: 5,
        body: "status body",
      }),
    ).rejects.toThrow("transient db failure");

    const recovered =
      await publicationModule.upsertDeliveryCanonicalStatusComment({
        db: makeDb({ id: workflowId, canonicalStatusCommentId: null }),
        workflowId,
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

  it("updates canonical check summary and includes Leo task link instead of direct artifact URL", async () => {
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

    await publicationModule.upsertDeliveryCanonicalCheckSummary({
      db: makeDb({
        id: "wf-3",
        threadId: "thread-3",
        canonicalCheckRunId: 321,
      }),
      workflowId: "wf-3",
      payload: {
        repoFullName: "owner/repo",
        prNumber: 3,
        title: "SDLC",
        summary: "All gates passed",
        status: "completed",
        conclusion: "success",
        artifactR2Key: "videos/wf-3.mp4",
      },
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 321,
        external_id: "leo-sdlc-loop-check-run:wf-3",
        output: expect.objectContaining({
          summary: expect.stringContaining("https://leo.example/task/"),
        }),
      }),
    );
    expect(persistWorkflowCheckRunReference).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf-3", checkRunId: 321 }),
    );
  });

  it("reconciles canonical check run before create to avoid duplicate side effects after DB persistence failure", async () => {
    const workflowId = "wf-check-reconcile";
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
                    external_id: `leo-sdlc-loop-check-run:${workflowId}`,
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
    vi.mocked(persistWorkflowCheckRunReference)
      .mockRejectedValueOnce(new Error("transient db failure"))
      .mockResolvedValue(undefined);

    await expect(
      publicationModule.upsertDeliveryCanonicalCheckSummary({
        db: makeDb({
          id: workflowId,
          threadId: "thread-9",
          canonicalCheckRunId: null,
        }),
        workflowId,
        payload: {
          repoFullName: "owner/repo",
          prNumber: 9,
          title: "Leo Delivery Loop",
          summary: "Gate summary",
          status: "completed",
          conclusion: "success",
        },
      }),
    ).rejects.toThrow("transient db failure");

    const recovered =
      await publicationModule.upsertDeliveryCanonicalCheckSummary({
        db: makeDb({
          id: workflowId,
          threadId: "thread-9",
          canonicalCheckRunId: null,
        }),
        workflowId,
        payload: {
          repoFullName: "owner/repo",
          prNumber: 9,
          title: "Leo Delivery Loop",
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
      publicationModule.classifyDeliveryPublicationFailure({ status: 429 })
        .errorClass,
    ).toBe("quota");
    expect(
      publicationModule.classifyDeliveryPublicationFailure({ status: 403 })
        .retriable,
    ).toBe(false);
    expect(
      publicationModule.classifyDeliveryPublicationFailure({ status: 502 })
        .retriable,
    ).toBe(true);
  });
});
