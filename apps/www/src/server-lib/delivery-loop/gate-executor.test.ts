import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ISandboxSession } from "@terragon/sandbox/types";
import {
  isBypassTokenValidForSha,
  resolveGateTransitionEvent,
  resolvePostGateState,
  gateStateToGateTypes,
  executeReviewGate,
  executeCiGate,
  executeUiGate,
  executeGatePipeline,
  type GatePipelineResult,
  type BypassOnceToken,
} from "./gate-executor";

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gateStateToGateTypes", () => {
  it("maps review_gate to deep_review and carmack_review", () => {
    expect(gateStateToGateTypes.review_gate).toEqual([
      "deep_review",
      "carmack_review",
    ]);
  });

  it("maps ci_gate to quality_check", () => {
    expect(gateStateToGateTypes.ci_gate).toEqual(["quality_check"]);
  });

  it("maps ui_gate to ui_smoke", () => {
    expect(gateStateToGateTypes.ui_gate).toEqual(["ui_smoke"]);
  });
});

describe("isBypassTokenValidForSha", () => {
  const baseToken: BypassOnceToken = {
    gate: "quality",
    headSha: "abc123",
    actorUserId: "user-1",
    loopVersion: 1,
    artifactId: "art-1",
  };

  it("returns true when SHA matches", () => {
    expect(isBypassTokenValidForSha(baseToken, "abc123")).toBe(true);
  });

  it("returns false when SHA differs", () => {
    expect(isBypassTokenValidForSha(baseToken, "def456")).toBe(false);
  });
});

describe("resolveGateTransitionEvent", () => {
  it("returns review_gate_passed when review gate passes", () => {
    const result: GatePipelineResult = {
      state: "review_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, false)).toBe(
      "review_gate_passed",
    );
  });

  it("returns review_gate_blocked when review gate fails", () => {
    const result: GatePipelineResult = {
      state: "review_gate",
      allPassed: false,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, false)).toBe(
      "review_gate_blocked",
    );
  });

  it("returns ci_gate_passed when ci gate passes", () => {
    const result: GatePipelineResult = {
      state: "ci_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, false)).toBe("ci_gate_passed");
  });

  it("returns ci_gate_blocked when ci gate fails", () => {
    const result: GatePipelineResult = {
      state: "ci_gate",
      allPassed: false,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, false)).toBe("ci_gate_blocked");
  });

  it("returns ui_gate_passed_with_pr when ui gate passes with PR", () => {
    const result: GatePipelineResult = {
      state: "ui_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, true)).toBe(
      "ui_gate_passed_with_pr",
    );
  });

  it("returns ui_gate_passed_without_pr when ui gate passes without PR", () => {
    const result: GatePipelineResult = {
      state: "ui_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, false)).toBe(
      "ui_gate_passed_without_pr",
    );
  });

  it("returns ui_gate_blocked when ui gate fails", () => {
    const result: GatePipelineResult = {
      state: "ui_gate",
      allPassed: false,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolveGateTransitionEvent(result, true)).toBe("ui_gate_blocked");
  });
});

describe("resolvePostGateState", () => {
  it("review_gate pass -> ci_gate", () => {
    const result: GatePipelineResult = {
      state: "review_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, false)).toBe("ci_gate");
  });

  it("review_gate fail -> implementing", () => {
    const result: GatePipelineResult = {
      state: "review_gate",
      allPassed: false,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, false)).toBe("implementing");
  });

  it("ci_gate pass -> ui_gate", () => {
    const result: GatePipelineResult = {
      state: "ci_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, false)).toBe("ui_gate");
  });

  it("ci_gate fail -> implementing", () => {
    const result: GatePipelineResult = {
      state: "ci_gate",
      allPassed: false,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, false)).toBe("implementing");
  });

  it("ui_gate pass with PR -> babysitting", () => {
    const result: GatePipelineResult = {
      state: "ui_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, true)).toBe("babysitting");
  });

  it("ui_gate pass without PR -> awaiting_pr_link", () => {
    const result: GatePipelineResult = {
      state: "ui_gate",
      allPassed: true,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, false)).toBe("awaiting_pr_link");
  });

  it("ui_gate fail -> implementing", () => {
    const result: GatePipelineResult = {
      state: "ui_gate",
      allPassed: false,
      gateResults: [],
      blockingFindings: [],
    };
    expect(resolvePostGateState(result, true)).toBe("implementing");
  });
});

describe("executeReviewGate", () => {
  it("runs deep and carmack reviews in parallel and returns combined result", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });

    const result = await executeReviewGate({
      session: mockSession,
      repoFullName: "org/repo",
      prNumber: 42,
      headSha: "abc123",
      taskContext: "test context",
      gitDiff: "diff content",
      model: "gpt-5.3-codex-medium",
    });

    expect(result.state).toBe("review_gate");
    expect(result.allPassed).toBe(true);
    expect(result.gateResults).toHaveLength(2);
    expect(result.blockingFindings).toHaveLength(0);
  });

  it("reports blocked when deep review fails", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: false,
      blockingFindings: [
        {
          title: "Bad code",
          severity: "high",
          category: "correctness",
          detail: "Something is wrong",
          suggestedFix: "Fix it",
          isBlocking: true,
        },
      ],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });

    const result = await executeReviewGate({
      session: mockSession,
      repoFullName: "org/repo",
      prNumber: null,
      headSha: "abc123",
      taskContext: "test context",
      gitDiff: "diff content",
      model: "gpt-5.3-codex-medium",
    });

    expect(result.allPassed).toBe(false);
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.blockingFindings[0]!.title).toBe("Bad code");
  });

  it("handles gate execution errors gracefully", async () => {
    vi.mocked(runDeepReviewGate).mockRejectedValue(
      new Error("Codex CLI crashed"),
    );
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });

    const result = await executeReviewGate({
      session: mockSession,
      repoFullName: "org/repo",
      prNumber: null,
      headSha: "abc123",
      taskContext: "test context",
      gitDiff: "diff content",
      model: "gpt-5.3-codex-medium",
    });

    expect(result.allPassed).toBe(false);
    const deepResult = result.gateResults.find(
      (r) => r.gateType === "deep_review",
    );
    expect(deepResult?.error).toBe("Codex CLI crashed");
    expect(deepResult?.passed).toBe(false);
  });
});

describe("executeCiGate", () => {
  it("runs quality check and returns result", async () => {
    vi.mocked(runQualityCheckGateInSandbox).mockResolvedValue({
      gatePassed: true,
      failures: [],
    });

    const result = await executeCiGate({
      session: mockSession,
      headSha: "abc123",
      bypassToken: null,
    });

    expect(result.state).toBe("ci_gate");
    expect(result.allPassed).toBe(true);
    expect(result.gateResults).toHaveLength(1);
    expect(result.gateResults[0]!.gateType).toBe("quality_check");
  });

  it("reports failures from quality check", async () => {
    vi.mocked(runQualityCheckGateInSandbox).mockResolvedValue({
      gatePassed: false,
      failures: ["pnpm run lint failed: 2 errors"],
    });

    const result = await executeCiGate({
      session: mockSession,
      headSha: "abc123",
      bypassToken: null,
    });

    expect(result.allPassed).toBe(false);
    expect(result.blockingFindings).toHaveLength(1);
  });

  it("bypasses quality check with SHA-matching bypass token", async () => {
    const result = await executeCiGate({
      session: mockSession,
      headSha: "abc123",
      bypassToken: {
        gate: "quality",
        headSha: "abc123",
        actorUserId: "user-1",
        loopVersion: 1,
        artifactId: "art-1",
      },
    });

    expect(result.allPassed).toBe(true);
    expect(result.gateResults[0]!.summary).toContain("bypassed");
    expect(runQualityCheckGateInSandbox).not.toHaveBeenCalled();
  });

  it("does NOT bypass when SHA does not match", async () => {
    vi.mocked(runQualityCheckGateInSandbox).mockResolvedValue({
      gatePassed: false,
      failures: ["test failed"],
    });

    const result = await executeCiGate({
      session: mockSession,
      headSha: "different-sha",
      bypassToken: {
        gate: "quality",
        headSha: "abc123",
        actorUserId: "user-1",
        loopVersion: 1,
        artifactId: "art-1",
      },
    });

    expect(result.allPassed).toBe(false);
    expect(runQualityCheckGateInSandbox).toHaveBeenCalled();
  });
});

describe("executeUiGate", () => {
  it("auto-passes when no frontend files changed", async () => {
    const result = await executeUiGate({
      session: mockSession,
      repoFullName: "org/repo",
      branchName: "feat/api-change",
      headSha: "abc123",
      changedFiles: ["src/server/api.ts", "README.md"],
      model: "gpt-5.3-codex-medium",
    });

    expect(result.state).toBe("ui_gate");
    expect(result.allPassed).toBe(true);
    expect(result.gateResults[0]!.summary).toContain("skipped");
    expect(mockSession.runCommand).not.toHaveBeenCalled();
  });

  it("runs build when frontend files are changed", async () => {
    vi.mocked(mockSession.runCommand).mockResolvedValue("Build succeeded");

    const result = await executeUiGate({
      session: mockSession,
      repoFullName: "org/repo",
      branchName: "feat/ui-change",
      headSha: "abc123",
      changedFiles: ["src/components/Button.tsx", "src/server/api.ts"],
      model: "gpt-5.3-codex-medium",
    });

    expect(result.state).toBe("ui_gate");
    expect(result.allPassed).toBe(true);
    expect(result.gateResults[0]!.gateType).toBe("ui_smoke");
    expect(mockSession.runCommand).toHaveBeenCalledWith("pnpm run build", {
      cwd: mockSession.repoDir,
      timeoutMs: 300_000,
    });
  });

  it("reports failure when build fails", async () => {
    vi.mocked(mockSession.runCommand).mockRejectedValue(
      new Error("Build error: type mismatch"),
    );

    const result = await executeUiGate({
      session: mockSession,
      repoFullName: "org/repo",
      branchName: "feat/broken-ui",
      headSha: "abc123",
      changedFiles: ["src/pages/index.vue"],
      model: "gpt-5.3-codex-medium",
    });

    expect(result.allPassed).toBe(false);
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.gateResults[0]!.error).toBe("Build error: type mismatch");
  });

  it("detects frontend patterns in nested paths", async () => {
    vi.mocked(mockSession.runCommand).mockResolvedValue("ok");

    const result = await executeUiGate({
      session: mockSession,
      repoFullName: "org/repo",
      branchName: "feat/page",
      headSha: "abc123",
      changedFiles: ["apps/web/src/app/dashboard/page.ts"],
      model: "gpt-5.3-codex-medium",
    });

    expect(result.allPassed).toBe(true);
    expect(mockSession.runCommand).toHaveBeenCalled();
  });
});

describe("executeGatePipeline", () => {
  const basePipelineInput = {
    reviewInput: {
      session: mockSession,
      repoFullName: "org/repo",
      prNumber: 42,
      headSha: "abc123",
      taskContext: "test context",
      gitDiff: "diff content",
      model: "gpt-5.3-codex-medium",
    },
    ciInput: {
      session: mockSession,
      headSha: "abc123",
      bypassToken: null,
    },
    uiInput: {
      session: mockSession,
      repoFullName: "org/repo",
      branchName: "feat/test",
      headSha: "abc123",
      changedFiles: ["src/lib/utils.ts"],
      model: "gpt-5.3-codex-medium",
    },
    hasPr: true,
  };

  it("sequences all three gates when all pass", async () => {
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

    const result = await executeGatePipeline(basePipelineInput);

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.state).toBe("review_gate");
    expect(result.results[1]!.state).toBe("ci_gate");
    expect(result.results[2]!.state).toBe("ui_gate");
    expect(result.nextState).toBe("babysitting");
    expect(result.stoppedAtGate).toBeNull();
  });

  it("returns awaiting_pr_link when all pass and no PR", async () => {
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

    const result = await executeGatePipeline({
      ...basePipelineInput,
      hasPr: false,
    });

    expect(result.allPassed).toBe(true);
    expect(result.nextState).toBe("awaiting_pr_link");
  });

  it("short-circuits at review_gate on failure", async () => {
    vi.mocked(runDeepReviewGate).mockResolvedValue({
      gatePassed: false,
      blockingFindings: [
        {
          title: "Bug",
          severity: "high",
          category: "correctness",
          detail: "Wrong logic",
          isBlocking: true,
        },
      ],
    });
    vi.mocked(runCarmackReviewGate).mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });

    const result = await executeGatePipeline(basePipelineInput);

    expect(result.allPassed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.stoppedAtGate).toBe("review_gate");
    expect(result.nextState).toBe("implementing");
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
      failures: ["lint failed"],
    });

    const result = await executeGatePipeline(basePipelineInput);

    expect(result.allPassed).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.stoppedAtGate).toBe("ci_gate");
    expect(result.nextState).toBe("implementing");
  });
});
