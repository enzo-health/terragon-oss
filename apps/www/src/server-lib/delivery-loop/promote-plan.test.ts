import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedPlanSpec } from "./parse-plan-spec";

// ─── hoisted mocks ────────────────────────────────────────────

const mockCreatePlanArtifactForLoop = vi.hoisted(() => vi.fn());
const mockApprovePlanArtifactForLoop = vi.hoisted(() => vi.fn());
const mockReplacePlanTasksForArtifact = vi.hoisted(() => vi.fn());
const mockTransitionSdlcLoopStateWithArtifact = vi.hoisted(() => vi.fn());
const mockGetActiveWorkflowForThread = vi.hoisted(() => vi.fn());
const mockAppendSignalToInbox = vi.hoisted(() => vi.fn());

vi.mock("@terragon/shared/model/delivery-loop", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/delivery-loop")
    >();
  return {
    ...actual,
    createPlanArtifactForLoop: mockCreatePlanArtifactForLoop,
    approvePlanArtifactForLoop: mockApprovePlanArtifactForLoop,
    replacePlanTasksForArtifact: mockReplacePlanTasksForArtifact,
    transitionSdlcLoopStateWithArtifact:
      mockTransitionSdlcLoopStateWithArtifact,
  };
});

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  getActiveWorkflowForThread: mockGetActiveWorkflowForThread,
}));

vi.mock("@terragon/shared/delivery-loop/store/signal-inbox-store", () => ({
  appendSignalToInbox: mockAppendSignalToInbox,
}));

// ─── import SUT after mocks ───────────────────────────────────

import { promotePlanToImplementing, type PlanSpecSource } from "./promote-plan";

// ─── helpers ──────────────────────────────────────────────────

const makeParsedPlan = (
  overrides?: Partial<ParsedPlanSpec> & { source?: PlanSpecSource },
): ParsedPlanSpec & { source?: PlanSpecSource } => ({
  planText: "Implement feature X",
  tasks: [
    {
      stableTaskId: "task-1",
      title: "Do the thing",
      description: "Description here",
      acceptance: ["It works"],
    },
  ],
  ...overrides,
});

const makeLoop = (overrides?: Record<string, unknown>) => ({
  id: "loop-1",
  loopVersion: 0,
  planApprovalPolicy: "auto" as const,
  ...overrides,
});

const fakeDb = {} as any;

function makeArtifact(overrides?: Record<string, unknown>) {
  return {
    id: "artifact-1",
    loopId: "loop-1",
    phase: "planning",
    artifactType: "plan_spec",
    status: "generated",
    loopVersion: 1,
    payload: {
      planText: "Implement feature X",
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Do the thing",
          description: "Description here",
          acceptance: ["It works"],
        },
      ],
      source: "system",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Category A: pure function tests ─────────────────────────

// buildPlanComparisonKey and buildPlanComparisonKeyFromArtifactPayload are
// not exported, but we can test them indirectly through selectPromotablePlanningArtifact
// behavior (dedup logic). We'll also import them directly since they're module-private
// but we can access them through the module internals.
// Since they're not exported, we test the dedup behavior end-to-end through
// promotePlanToImplementing (approve mode finds matching artifact).

describe("plan deduplication (via approve mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveWorkflowForThread.mockResolvedValue(null);
    mockAppendSignalToInbox.mockResolvedValue(undefined);
  });

  it("reuses existing matching artifact instead of creating a new one", async () => {
    const plan = makeParsedPlan();
    const existingArtifact = makeArtifact({ status: "generated" });

    // Mock the DB query for getPromotablePlanningArtifacts
    const mockFindMany = vi.fn().mockResolvedValue([existingArtifact]);
    const db = {
      query: {
        sdlcPhaseArtifact: { findMany: mockFindMany },
      },
    } as any;

    mockApprovePlanArtifactForLoop.mockResolvedValue({
      ...existingArtifact,
      status: "approved",
    });
    mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

    const result = await promotePlanToImplementing({
      db,
      loop: makeLoop({ planApprovalPolicy: "human_required" }),
      parsedPlan: plan,
      mode: "approve",
      approvedByUserId: "user-1",
    });

    // Should NOT have created a new artifact
    expect(mockCreatePlanArtifactForLoop).not.toHaveBeenCalled();
    // Should have approved the existing one
    expect(mockApprovePlanArtifactForLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-1",
        approvedByUserId: "user-1",
      }),
    );
    expect(result.outcome).toBe("promoted");
  });

  it("creates new artifact when no matching artifact exists", async () => {
    const plan = makeParsedPlan({ planText: "Totally different plan" });
    const existingArtifact = makeArtifact({
      payload: {
        planText: "Original plan",
        tasks: [
          {
            stableTaskId: "task-99",
            title: "Other task",
            description: null,
            acceptance: [],
          },
        ],
      },
    });

    const db = {
      query: {
        sdlcPhaseArtifact: {
          findMany: vi.fn().mockResolvedValue([existingArtifact]),
        },
      },
    } as any;

    const newArtifact = makeArtifact({
      id: "artifact-new",
      status: "generated",
    });
    mockCreatePlanArtifactForLoop.mockResolvedValue(newArtifact);
    mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
    mockApprovePlanArtifactForLoop.mockResolvedValue({
      ...newArtifact,
      status: "approved",
    });
    mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

    const result = await promotePlanToImplementing({
      db,
      loop: makeLoop({ planApprovalPolicy: "human_required" }),
      parsedPlan: plan,
      mode: "approve",
      approvedByUserId: "user-1",
    });

    expect(mockCreatePlanArtifactForLoop).toHaveBeenCalled();
    expect(result.outcome).toBe("promoted");
  });

  it("prefers approved matching artifact over generated one", async () => {
    const plan = makeParsedPlan();
    const generatedArtifact = makeArtifact({
      id: "artifact-gen",
      status: "generated",
    });
    const approvedArtifact = makeArtifact({
      id: "artifact-approved",
      status: "approved",
    });

    const db = {
      query: {
        sdlcPhaseArtifact: {
          findMany: vi
            .fn()
            .mockResolvedValue([generatedArtifact, approvedArtifact]),
        },
      },
    } as any;

    mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

    const result = await promotePlanToImplementing({
      db,
      loop: makeLoop({ planApprovalPolicy: "human_required" }),
      parsedPlan: plan,
      mode: "approve",
      approvedByUserId: "user-1",
    });

    // Should NOT approve again — already approved
    expect(mockApprovePlanArtifactForLoop).not.toHaveBeenCalled();
    expect(result.artifactId).toBe("artifact-approved");
    expect(result.outcome).toBe("promoted");
  });

  it("different task ordering produces different comparison keys (no reuse)", async () => {
    const plan = makeParsedPlan({
      tasks: [
        {
          stableTaskId: "task-2",
          title: "Second",
          description: null,
          acceptance: [],
        },
        {
          stableTaskId: "task-1",
          title: "First",
          description: null,
          acceptance: [],
        },
      ],
    });

    // Existing artifact has tasks in opposite order
    const existingArtifact = makeArtifact({
      payload: {
        planText: "Implement feature X",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "First",
            description: null,
            acceptance: [],
          },
          {
            stableTaskId: "task-2",
            title: "Second",
            description: null,
            acceptance: [],
          },
        ],
      },
    });

    const db = {
      query: {
        sdlcPhaseArtifact: {
          findMany: vi.fn().mockResolvedValue([existingArtifact]),
        },
      },
    } as any;

    const newArtifact = makeArtifact({ id: "artifact-new" });
    mockCreatePlanArtifactForLoop.mockResolvedValue(newArtifact);
    mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
    mockApprovePlanArtifactForLoop.mockResolvedValue({
      ...newArtifact,
      status: "approved",
    });
    mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

    await promotePlanToImplementing({
      db,
      loop: makeLoop({ planApprovalPolicy: "human_required" }),
      parsedPlan: plan,
      mode: "approve",
      approvedByUserId: "user-1",
    });

    // Different order → no match → creates new artifact
    expect(mockCreatePlanArtifactForLoop).toHaveBeenCalled();
  });

  it("whitespace normalization allows matching with extra spaces", async () => {
    const plan = makeParsedPlan({
      planText: "  Implement feature X  ",
      tasks: [
        {
          stableTaskId: "  task-1  ",
          title: "  Do the thing  ",
          description: "  Description here  ",
          acceptance: ["  It works  "],
        },
      ],
    });

    // Existing artifact has trimmed values
    const existingArtifact = makeArtifact();

    const db = {
      query: {
        sdlcPhaseArtifact: {
          findMany: vi.fn().mockResolvedValue([existingArtifact]),
        },
      },
    } as any;

    mockApprovePlanArtifactForLoop.mockResolvedValue({
      ...existingArtifact,
      status: "approved",
    });
    mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

    await promotePlanToImplementing({
      db,
      loop: makeLoop({ planApprovalPolicy: "human_required" }),
      parsedPlan: plan,
      mode: "approve",
      approvedByUserId: "user-1",
    });

    // Whitespace-normalized → matches existing → no new artifact
    expect(mockCreatePlanArtifactForLoop).not.toHaveBeenCalled();
  });
});

// ─── Category B: promotePlanToImplementing unit tests ─────────

describe("promotePlanToImplementing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveWorkflowForThread.mockResolvedValue(null);
    mockAppendSignalToInbox.mockResolvedValue(undefined);
  });

  describe("mode: checkpoint", () => {
    it("auto approval: creates accepted artifact + writes plan_approved signal", async () => {
      const plan = makeParsedPlan({ source: "exit_plan_mode" });
      const artifact = makeArtifact({ id: "art-1", status: "accepted" });

      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      const result = await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "auto" }),
        parsedPlan: plan,
        mode: "checkpoint",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "accepted",
          loopVersion: 1,
          payload: expect.objectContaining({
            planText: "Implement feature X",
            source: "exit_plan_mode",
          }),
        }),
      );

      expect(mockTransitionSdlcLoopStateWithArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          loopId: "loop-1",
          artifactId: "art-1",
          expectedPhase: "planning",
          transitionEvent: "plan_completed",
        }),
      );

      expect(mockAppendSignalToInbox).toHaveBeenCalledWith(
        expect.objectContaining({
          loopId: "loop-1",
          causeType: "human_resume",
          payload: {
            source: "human",
            event: {
              kind: "plan_approved",
              artifactId: "art-1",
            },
          },
          canonicalCauseId: "plan-promoted:loop-1:art-1",
        }),
      );

      expect(result).toEqual({
        outcome: "promoted",
        artifactId: "art-1",
        loopVersion: 1,
      });
    });

    it("human_required: creates generated artifact + returns awaiting_human_approval (no signal)", async () => {
      const plan = makeParsedPlan();
      const artifact = makeArtifact({ id: "art-2", status: "generated" });

      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      const result = await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: plan,
        mode: "checkpoint",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ status: "generated" }),
      );

      // No transition, no signal
      expect(mockTransitionSdlcLoopStateWithArtifact).not.toHaveBeenCalled();
      expect(mockAppendSignalToInbox).not.toHaveBeenCalled();

      expect(result).toEqual({
        outcome: "awaiting_human_approval",
        artifactId: "art-2",
        loopVersion: 1,
      });
    });

    it("increments loopVersion correctly", async () => {
      const artifact = makeArtifact({ id: "art-3" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({
          loopVersion: 5,
          planApprovalPolicy: "human_required",
        }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ loopVersion: 6 }),
      );
    });

    it("handles non-finite loopVersion by defaulting to 1", async () => {
      const artifact = makeArtifact({ id: "art-4" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({
          loopVersion: NaN,
          planApprovalPolicy: "human_required",
        }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ loopVersion: 1 }),
      );
    });
  });

  describe("mode: approve", () => {
    it("approves artifact and transitions to implementing", async () => {
      const plan = makeParsedPlan();
      const existingArtifact = makeArtifact({ status: "generated" });
      const approvedArtifact = {
        ...existingArtifact,
        id: "artifact-1",
        status: "approved",
        loopVersion: 1,
      };

      const db = {
        query: {
          sdlcPhaseArtifact: {
            findMany: vi.fn().mockResolvedValue([existingArtifact]),
          },
        },
      } as any;

      mockApprovePlanArtifactForLoop.mockResolvedValue(approvedArtifact);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      const result = await promotePlanToImplementing({
        db,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: plan,
        mode: "approve",
        approvedByUserId: "user-1",
      });

      expect(mockApprovePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          loopId: "loop-1",
          artifactId: "artifact-1",
          approvedByUserId: "user-1",
        }),
      );

      expect(result.outcome).toBe("promoted");
      expect(mockAppendSignalToInbox).toHaveBeenCalled();
    });

    it("throws when approvedByUserId missing for human_required", async () => {
      const plan = makeParsedPlan();
      const existingArtifact = makeArtifact({ status: "generated" });

      const db = {
        query: {
          sdlcPhaseArtifact: {
            findMany: vi.fn().mockResolvedValue([existingArtifact]),
          },
        },
      } as any;

      await expect(
        promotePlanToImplementing({
          db,
          loop: makeLoop({ planApprovalPolicy: "human_required" }),
          parsedPlan: plan,
          mode: "approve",
        }),
      ).rejects.toThrow(
        "approve mode requires approvedByUserId for human_required loops",
      );
    });

    it("uses fallback artifact when approvePlanArtifactForLoop returns undefined", async () => {
      const plan = makeParsedPlan();
      const existingArtifact = makeArtifact({
        id: "artifact-orig",
        status: "generated",
      });
      const fallbackApproved = makeArtifact({
        id: "artifact-fallback",
        status: "approved",
        loopVersion: 2,
      });

      const findManyMock = vi
        .fn()
        // First call: initial lookup
        .mockResolvedValueOnce([existingArtifact])
        // Second call: refresh after approve fails
        .mockResolvedValueOnce([fallbackApproved]);

      const db = {
        query: {
          sdlcPhaseArtifact: { findMany: findManyMock },
        },
      } as any;

      mockApprovePlanArtifactForLoop.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      const result = await promotePlanToImplementing({
        db,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: plan,
        mode: "approve",
        approvedByUserId: "user-1",
      });

      expect(result.outcome).toBe("promoted");
      expect(result.artifactId).toBe("artifact-fallback");
    });

    it("throws when approve fails and no fallback found", async () => {
      const plan = makeParsedPlan();
      const existingArtifact = makeArtifact({ status: "generated" });

      const findManyMock = vi
        .fn()
        .mockResolvedValueOnce([existingArtifact])
        .mockResolvedValueOnce([]); // No fallback

      const db = {
        query: {
          sdlcPhaseArtifact: { findMany: findManyMock },
        },
      } as any;

      mockApprovePlanArtifactForLoop.mockResolvedValue(undefined);

      await expect(
        promotePlanToImplementing({
          db,
          loop: makeLoop({ planApprovalPolicy: "human_required" }),
          parsedPlan: plan,
          mode: "approve",
          approvedByUserId: "user-1",
        }),
      ).rejects.toThrow("Failed to approve plan artifact before promotion");
    });

    it("auto approval policy in approve mode: creates accepted artifact and transitions", async () => {
      const plan = makeParsedPlan();
      const artifact = makeArtifact({ id: "art-auto", status: "accepted" });

      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      const result = await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "auto" }),
        parsedPlan: plan,
        mode: "approve",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ status: "accepted" }),
      );
      expect(result.outcome).toBe("promoted");
      expect(mockAppendSignalToInbox).toHaveBeenCalled();
    });
  });

  describe("v2 signal bridge", () => {
    it("writes signal with correct shape on successful promotion", async () => {
      const artifact = makeArtifact({ id: "art-sig", status: "accepted" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "auto" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockAppendSignalToInbox).toHaveBeenCalledTimes(1);
      const call = mockAppendSignalToInbox.mock.calls[0]![0];
      expect(call.causeType).toBe("human_resume");
      expect(call.payload.source).toBe("human");
      expect(call.payload.event.kind).toBe("plan_approved");
      expect(call.payload.event.artifactId).toBe("art-sig");
      expect(call.canonicalCauseId).toBe("plan-promoted:loop-1:art-sig");
    });

    it("retries signal write once on failure", async () => {
      const artifact = makeArtifact({ id: "art-retry", status: "accepted" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      mockAppendSignalToInbox
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(undefined);

      const result = await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "auto" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockAppendSignalToInbox).toHaveBeenCalledTimes(2);
      expect(result.outcome).toBe("promoted");
    });

    it("still returns promoted even if signal write fails after retry", async () => {
      const artifact = makeArtifact({ id: "art-fail", status: "accepted" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("updated");

      mockAppendSignalToInbox
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"));

      const result = await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "auto" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockAppendSignalToInbox).toHaveBeenCalledTimes(2);
      // v1 transition committed — still returns promoted
      expect(result.outcome).toBe("promoted");
    });

    it("does not write signal when transition is blocked", async () => {
      const artifact = makeArtifact({ id: "art-blocked", status: "accepted" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);
      mockTransitionSdlcLoopStateWithArtifact.mockResolvedValue("stale_noop");

      const result = await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "auto" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockAppendSignalToInbox).not.toHaveBeenCalled();
      expect(result.outcome).toBe("promotion_blocked");
    });
  });

  describe("v2 workflow lookup", () => {
    it("passes workflowId from v2 workflow when threadId is provided", async () => {
      mockGetActiveWorkflowForThread.mockResolvedValue({
        id: "wf-1",
        threadId: "thread-1",
      });

      const artifact = makeArtifact({ id: "art-wf", status: "generated" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
        threadId: "thread-1",
      });

      expect(mockGetActiveWorkflowForThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-1" }),
      );
      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: "wf-1" }),
      );
    });

    it("passes null workflowId when no threadId provided", async () => {
      const artifact = makeArtifact({ id: "art-no-wf", status: "generated" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
      });

      expect(mockGetActiveWorkflowForThread).not.toHaveBeenCalled();
      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: null }),
      );
    });

    it("passes null workflowId when workflow lookup returns null", async () => {
      mockGetActiveWorkflowForThread.mockResolvedValue(null);

      const artifact = makeArtifact({ id: "art-null-wf", status: "generated" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: makeParsedPlan(),
        mode: "checkpoint",
        threadId: "thread-1",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: null }),
      );
    });
  });

  describe("plan source resolution", () => {
    it.each(["exit_plan_mode", "write_tool", "agent_text", "system"] as const)(
      "preserves source=%s in artifact payload",
      async (source) => {
        const artifact = makeArtifact({ id: `art-${source}` });
        mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
        mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

        await promotePlanToImplementing({
          db: fakeDb,
          loop: makeLoop({ planApprovalPolicy: "human_required" }),
          parsedPlan: makeParsedPlan({ source }),
          mode: "checkpoint",
        });

        expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ source }),
          }),
        );
      },
    );

    it("defaults to system when source is unknown", async () => {
      const artifact = makeArtifact({ id: "art-default" });
      mockCreatePlanArtifactForLoop.mockResolvedValue(artifact);
      mockReplacePlanTasksForArtifact.mockResolvedValue(undefined);

      await promotePlanToImplementing({
        db: fakeDb,
        loop: makeLoop({ planApprovalPolicy: "human_required" }),
        parsedPlan: makeParsedPlan({
          source: "unknown_source" as PlanSpecSource,
        }),
        mode: "checkpoint",
      });

      expect(mockCreatePlanArtifactForLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ source: "system" }),
        }),
      );
    });
  });
});
