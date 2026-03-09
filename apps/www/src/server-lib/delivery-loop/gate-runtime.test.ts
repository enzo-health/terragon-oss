import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ISandboxSession } from "@terragon/sandbox/types";
import {
  runGatePipeline,
  shouldConsumeBypass,
  type GateRuntimeInput,
} from "./gate-runtime";

vi.mock("./quality-check-gate", () => ({
  runQualityCheckGateInSandbox: vi.fn(),
}));

vi.mock("./deep-review-gate", () => ({
  runDeepReviewGate: vi.fn(),
}));

vi.mock("./carmack-review-gate", () => ({
  runCarmackReviewGate: vi.fn(),
}));

const { runQualityCheckGateInSandbox } = await import("./quality-check-gate");
const { runDeepReviewGate } = await import("./deep-review-gate");
const { runCarmackReviewGate } = await import("./carmack-review-gate");

const mockSession = {
  repoDir: "/repo",
  runCommand: vi.fn(),
  writeTextFile: vi.fn(),
} as unknown as ISandboxSession;

function baseInput(overrides?: Partial<GateRuntimeInput>): GateRuntimeInput {
  return {
    session: mockSession,
    repoFullName: "org/repo",
    prNumber: 42,
    branchName: "feat/test",
    headSha: "abc123",
    taskContext: "implement feature X",
    gitDiff: "diff content",
    changedFiles: ["src/lib/utils.ts"],
    model: "gpt-5.3-codex-medium",
    hasPr: true,
    bypassToken: null,
    ...overrides,
  };
}

function mockAllGatesPass() {
  vi.mocked(runDeepReviewGate).mockResolvedValue({
    gatePassed: true,
    blockingFindings: [],
  });
  vi.mocked(runCarmackReviewGate).mockResolvedValue({
    gatePassed: true,
    blockingFindings: [],
  });
  vi.mocked(runQualityCheckGateInSandbox).mockResolvedValue({
    gatePassed: true,
    failures: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shouldConsumeBypass", () => {
  it("returns false for null token", () => {
    expect(shouldConsumeBypass(null, "abc123")).toBe(false);
  });

  it("returns true when SHA matches", () => {
    expect(
      shouldConsumeBypass(
        {
          gate: "quality",
          headSha: "abc123",
          actorUserId: "user-1",
          loopVersion: 1,
          artifactId: "art-1",
        },
        "abc123",
      ),
    ).toBe(true);
  });

  it("returns false when SHA differs", () => {
    expect(
      shouldConsumeBypass(
        {
          gate: "quality",
          headSha: "abc123",
          actorUserId: "user-1",
          loopVersion: 1,
          artifactId: "art-1",
        },
        "def456",
      ),
    ).toBe(false);
  });
});

describe("runGatePipeline", () => {
  it("sequences all three gates and returns babysitting when all pass with PR", async () => {
    mockAllGatesPass();

    const outcome = await runGatePipeline(baseInput());

    expect(outcome.allPassed).toBe(true);
    expect(outcome.gateResults).toHaveLength(3);
    expect(outcome.gateResults[0]!.gate).toBe("review_gate");
    expect(outcome.gateResults[1]!.gate).toBe("ci_gate");
    expect(outcome.gateResults[2]!.gate).toBe("ui_gate");
    expect(outcome.nextState).toBe("babysitting");
    expect(outcome.stoppedAtGate).toBeNull();
    expect(outcome.rawResults).toHaveLength(3);
  });

  it("returns awaiting_pr_link when all pass without PR", async () => {
    mockAllGatesPass();

    const outcome = await runGatePipeline(baseInput({ hasPr: false }));

    expect(outcome.allPassed).toBe(true);
    expect(outcome.nextState).toBe("awaiting_pr_link");
  });

  it("short-circuits at review_gate on failure", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: false,
      blockingFindings: [
        {
          title: "Bug found",
          severity: "high",
          category: "correctness",
          detail: "Null pointer",
          isBlocking: true,
        },
      ],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });

    const outcome = await runGatePipeline(baseInput());

    expect(outcome.allPassed).toBe(false);
    expect(outcome.gateResults).toHaveLength(1);
    expect(outcome.stoppedAtGate).toBe("review_gate");
    expect(outcome.nextState).toBe("implementing");
    expect(outcome.gateResults[0]!.passed).toBe(false);
    expect(outcome.gateResults[0]!.failureReason).toBeTruthy();
    // ci and ui gates should not have been called
    expect(runQualityCheckGateInSandbox).not.toHaveBeenCalled();
  });

  it("short-circuits at ci_gate on failure", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    vi.mocked(runQualityCheckGateInSandbox).mockResolvedValue({
      gatePassed: false,
      failures: ["pnpm run lint failed"],
    });

    const outcome = await runGatePipeline(baseInput());

    expect(outcome.allPassed).toBe(false);
    expect(outcome.gateResults).toHaveLength(2);
    expect(outcome.stoppedAtGate).toBe("ci_gate");
    expect(outcome.nextState).toBe("implementing");
  });

  it("short-circuits at ui_gate on failure", async () => {
    mockAllGatesPass();
    vi.mocked(mockSession.runCommand).mockRejectedValue(
      new Error("Build failed"),
    );

    const outcome = await runGatePipeline(
      baseInput({ changedFiles: ["src/components/Button.tsx"] }),
    );

    expect(outcome.allPassed).toBe(false);
    expect(outcome.gateResults).toHaveLength(3);
    expect(outcome.stoppedAtGate).toBe("ui_gate");
    expect(outcome.nextState).toBe("implementing");
  });

  it("GateResult includes provenance fields", async () => {
    mockAllGatesPass();

    const outcome = await runGatePipeline(baseInput());

    for (const result of outcome.gateResults) {
      expect(result.headSha).toBe("abc123");
      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);
      expect(result.passed).toBe(true);
      expect(result.failureReason).toBeNull();
    }
  });

  it("passes bypass token through to ci_gate", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });

    const outcome = await runGatePipeline(
      baseInput({
        bypassToken: {
          gate: "quality",
          headSha: "abc123",
          actorUserId: "user-1",
          loopVersion: 1,
          artifactId: "art-1",
        },
      }),
    );

    expect(outcome.allPassed).toBe(true);
    // Quality check should NOT have been called — bypass consumed
    expect(runQualityCheckGateInSandbox).not.toHaveBeenCalled();
    const ciResult = outcome.gateResults.find((r) => r.gate === "ci_gate");
    expect(ciResult?.passed).toBe(true);
  });

  it("does NOT bypass ci_gate when SHA does not match", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    vi.mocked(runQualityCheckGateInSandbox).mockResolvedValue({
      gatePassed: false,
      failures: ["lint error"],
    });

    const outcome = await runGatePipeline(
      baseInput({
        bypassToken: {
          gate: "quality",
          headSha: "old-sha",
          actorUserId: "user-1",
          loopVersion: 1,
          artifactId: "art-1",
        },
      }),
    );

    expect(outcome.allPassed).toBe(false);
    expect(runQualityCheckGateInSandbox).toHaveBeenCalled();
  });
});
