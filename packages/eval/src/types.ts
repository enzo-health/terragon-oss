/**
 * Core types for the eval harness.
 *
 * EvalFixture: A captured prod trace normalized for local replay.
 * EvalRun: Output from replaying a fixture through the delivery loop.
 * EvalMetrics: Quantified measurements for comparison.
 */

// ---------------------------------------------------------------------------
// Fixture — captured from prod, committed to git
// ---------------------------------------------------------------------------

export type EvalFixture = {
  version: 1;
  capturedAt: string;
  sourceThreadId: string;
  sourceThreadChatId: string;

  thread: {
    name: string | null;
    githubRepoFullName: string;
    repoBaseBranchName: string;
    branchName: string | null;
    sandboxProvider: string;
    sandboxSize: string | null;
  };

  threadChat: {
    agent: string;
    agentVersion: number;
    permissionMode: string;
    /** Only user messages from the original prompt — not the full trace */
    userMessages: SerializedUserMessage[];
  };

  loop: {
    planApprovalPolicy: string;
    maxFixAttempts: number;
  };

  plan: {
    planText: string;
    tasks: EvalPlanTask[];
  } | null;

  /** Signals in receivedAt order — the "script" for signal replay */
  signals: EvalSignal[];

  /** Review findings from prod (baseline for quality comparison) */
  prodFindings: {
    deep: EvalFinding[];
    carmack: EvalFinding[];
  };

  /** Artifacts produced in prod */
  prodArtifacts: EvalArtifact[];

  /** Baseline metrics computed from the prod trace */
  baselineMetrics: EvalMetrics;
};

export type SerializedUserMessage = {
  role: "user";
  content: string;
  timestamp: string;
};

export type EvalPlanTask = {
  stableTaskId: string;
  title: string;
  acceptanceCriteria: string[];
  status: string;
};

export type EvalSignal = {
  index: number;
  causeType: string;
  canonicalCauseId: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  delayFromPreviousMs: number;
};

export type EvalFinding = {
  stableFindingId: string;
  title: string;
  severity: string;
  category: string;
  isBlocking: boolean;
  headSha: string | null;
  reviewer: "deep" | "carmack";
};

export type EvalArtifact = {
  phase: string;
  artifactType: string;
  status: string;
  headSha: string | null;
  createdAt: string;
  payloadSummary: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Run — output from a local replay, stored in runs/ (gitignored)
// ---------------------------------------------------------------------------

export type EvalRun = {
  id: string;
  fixtureId: string;
  codeVersion: string; // git sha of the code being tested
  mode: "signal" | "sandbox";
  startedAt: string;
  completedAt: string;
  stateTrace: StateTransition[];
  metrics: EvalMetrics;
  findings: {
    deep: EvalFinding[];
    carmack: EvalFinding[];
  };
};

export type StateTransition = {
  loopVersion: number;
  previousState: string;
  nextState: string;
  event: string;
  timestamp: string;
  fixAttemptCount: number;
};

// ---------------------------------------------------------------------------
// Metrics — quantified measurements for comparison
// ---------------------------------------------------------------------------

export type EvalMetrics = {
  // Loop efficiency
  totalSignals: number;
  fixCycles: number;
  maxFixCyclesBeforeBlock: number;
  totalDurationMs: number;
  convergenceRate: number; // 1.0 = no fix cycles, lower = more rework

  // Finding quality
  totalFindings: number;
  blockingFindings: number;
  uniqueRootCauses: number;
  signalToNoiseRatio: number; // uniqueRootCauses / totalFindings
  crossReviewerDuplicates: number;

  // Outcome
  finalState: string;
  succeeded: boolean;
};

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

export type MetricComparison = {
  metric: string;
  baseline: number | string;
  current: number | string;
  delta: string;
  improved: boolean | null; // null = no change
};

export type EvalReport = {
  fixtureId: string;
  baselineCodeVersion: string;
  currentCodeVersion: string;
  comparisons: MetricComparison[];
  summary: string;
};
