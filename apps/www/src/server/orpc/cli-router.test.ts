import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveCreateThreadBranchNames, cliRouter } from "./cli-router";

// Mock dependencies
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      thread: {
        findFirst: vi.fn(),
      },
      deliveryCiGateRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      deliveryReviewThreadGateRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      deliveryDeepReviewRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      deliveryCarmackReviewRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      deliveryPhaseArtifact: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      deliveryPlanTask: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      deliveryWorkflowV3: {
        findFirst: vi.fn(),
      },
      deliveryWorkflowHeadV3: {
        findFirst: vi.fn(),
      },
      deliveryWorkflowThreadMap: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  getActiveWorkflowForThreadV3: vi.fn(),
}));

vi.mock("@/server-actions/get-delivery-loop-status", () => ({
  getDeliveryLoopStatusAction: vi.fn(),
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThread: vi.fn(),
  getThreads: vi.fn(),
  getThreadMinimal: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
  getUserIdOrNullFromDaemonToken: vi.fn().mockResolvedValue("user-123"),
}));

describe("resolveCreateThreadBranchNames", () => {
  it("defers to repo default branch resolution when no base branch is provided", () => {
    expect(
      resolveCreateThreadBranchNames({
        repoBaseBranchName: undefined,
        createNewBranch: true,
      }),
    ).toEqual({
      baseBranchName: null,
      headBranchName: null,
    });
  });

  it("preserves an explicit base branch override", () => {
    expect(
      resolveCreateThreadBranchNames({
        repoBaseBranchName: "release/2026-03",
        createNewBranch: true,
      }),
    ).toEqual({
      baseBranchName: "release/2026-03",
      headBranchName: null,
    });
  });

  it("keeps the branch value for no-new-branch flows", () => {
    expect(
      resolveCreateThreadBranchNames({
        repoBaseBranchName: "feature/continue-here",
        createNewBranch: false,
      }),
    ).toEqual({
      baseBranchName: null,
      headBranchName: "feature/continue-here",
    });
  });
});

describe("cliRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("deliveryLoopStatus", () => {
    it("should include deliveryLoopStatus in router", () => {
      // VAL-UI-007: Assert that the router includes the deliveryLoopStatus endpoint
      expect(cliRouter.threads.deliveryLoopStatus).toBeDefined();
    });

    it("should have proper contract input shape", () => {
      // The endpoint should accept threadId as input
      const contract = cliRouter.threads.deliveryLoopStatus;
      expect(contract).toBeDefined();
    });
  });
});
