/**
 * Normalizes raw DB rows into the EvalFixture format.
 */

import type {
  EvalFixture,
  EvalSignal,
  EvalFinding,
  EvalArtifact,
  EvalGateEvent,
  EvalPlanTask,
  EvalMetrics,
  SerializedUserMessage,
} from "../types";

type RawThread = {
  name: string | null;
  githubRepoFullName: string;
  repoBaseBranchName: string;
  branchName: string | null;
  sandboxProvider: string;
  sandboxSize: string | null;
};

type RawThreadChat = {
  id: string;
  agent: string;
  agentVersion: number;
  permissionMode: string | null;
  messages: any[] | null;
};

type RawLoop = {
  planApprovalPolicy: string;
  maxFixAttempts: number;
  fixAttemptCount: number;
  state: string;
};

type RawSignal = {
  causeType: string;
  canonicalCauseId: string;
  payload: Record<string, unknown> | null;
  receivedAt: Date;
};

type RawFinding = {
  stableFindingId: string;
  title: string;
  severity: string;
  category: string;
  isBlocking: boolean;
  headSha: string | null;
};

type RawArtifact = {
  phase: string;
  artifactType: string;
  status: string;
  headSha: string | null;
  createdAt: Date;
  payload: any;
};

type RawPlanTask = {
  stableTaskId: string;
  title: string;
  acceptance: string[];
  status: string;
};

// ---------------------------------------------------------------------------
// User message extraction
// ---------------------------------------------------------------------------

export function extractUserMessages(
  messages: any[] | null,
): SerializedUserMessage[] {
  if (!messages || !Array.isArray(messages)) return [];
  return messages
    .filter((m: any) => m.type === "user")
    .map((m: any) => {
      const content =
        m.parts
          ?.filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n") ?? "";
      return {
        role: "user" as const,
        content,
        timestamp: m.timestamp ?? new Date().toISOString(),
      };
    });
}

// ---------------------------------------------------------------------------
// Signal normalization
// ---------------------------------------------------------------------------

export function normalizeSignals(raw: RawSignal[]): EvalSignal[] {
  return raw.map((s, i) => {
    const receivedAt = s.receivedAt.getTime();
    const prevReceivedAt =
      i > 0 ? raw[i - 1]!.receivedAt.getTime() : receivedAt;
    return {
      index: i,
      causeType: s.causeType,
      canonicalCauseId: s.canonicalCauseId,
      payload: s.payload ?? {},
      receivedAt: s.receivedAt.toISOString(),
      delayFromPreviousMs: i === 0 ? 0 : receivedAt - prevReceivedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Finding normalization
// ---------------------------------------------------------------------------

export function normalizeFindings(
  raw: RawFinding[],
  reviewer: "deep" | "carmack",
): EvalFinding[] {
  return raw.map((f) => ({
    stableFindingId: f.stableFindingId,
    title: f.title,
    severity: f.severity,
    category: f.category,
    isBlocking: f.isBlocking,
    headSha: f.headSha,
    reviewer,
  }));
}

// ---------------------------------------------------------------------------
// Artifact normalization
// ---------------------------------------------------------------------------

export function normalizeArtifacts(raw: RawArtifact[]): EvalArtifact[] {
  return raw.map((a) => ({
    phase: a.phase,
    artifactType: a.artifactType,
    status: a.status,
    headSha: a.headSha,
    createdAt: a.createdAt.toISOString(),
    payloadSummary: summarizePayload(a.payload),
  }));
}

function summarizePayload(payload: any): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  // Keep top-level keys but truncate large nested values
  const summary: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === "string" && val.length > 500) {
      summary[key] = val.slice(0, 500) + "...[truncated]";
    } else if (Array.isArray(val)) {
      summary[key] = `[Array(${val.length})]`;
    } else if (typeof val === "object" && val !== null) {
      summary[key] = `[Object]`;
    } else {
      summary[key] = val;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Plan task normalization
// ---------------------------------------------------------------------------

export function normalizePlanTasks(raw: RawPlanTask[]): EvalPlanTask[] {
  return raw.map((t) => ({
    stableTaskId: t.stableTaskId,
    title: t.title,
    acceptanceCriteria: t.acceptance ?? [],
    status: t.status,
  }));
}

// ---------------------------------------------------------------------------
// Baseline metrics computation
// ---------------------------------------------------------------------------

export function computeBaselineMetrics(
  signals: EvalSignal[],
  deepFindings: EvalFinding[],
  carmackFindings: EvalFinding[],
  loop: RawLoop,
): EvalMetrics {
  const totalSignals = signals.length;

  // Count fix cycles: review_gate -> implementing transitions visible as
  // consecutive signals where the loop cycled through review_gate
  let fixCycles = 0;
  for (let i = 1; i < signals.length; i++) {
    const prev = signals[i - 1]!;
    const curr = signals[i]!;
    // A fix cycle is when we see review_gate cause followed by implementing-related cause
    if (
      prev.causeType.includes("review") &&
      curr.causeType.includes("implement")
    ) {
      fixCycles++;
    }
  }
  // Fall back to fixAttemptCount from the loop if heuristic finds nothing
  if (fixCycles === 0) {
    fixCycles = loop.fixAttemptCount;
  }

  const allFindings = [...deepFindings, ...carmackFindings];
  const totalFindings = allFindings.length;
  const blockingFindings = allFindings.filter((f) => f.isBlocking).length;

  const uniqueRootCauses = new Set(allFindings.map((f) => f.stableFindingId))
    .size;

  const signalToNoiseRatio =
    totalFindings > 0 ? uniqueRootCauses / totalFindings : 1;

  const convergenceRate = 1 / (1 + fixCycles);

  // Cross-reviewer duplicates: findings with same stableFindingId across deep & carmack
  const deepIds = new Set(deepFindings.map((f) => f.stableFindingId));
  const carmackIds = new Set(carmackFindings.map((f) => f.stableFindingId));
  let crossReviewerDuplicates = 0;
  for (const id of deepIds) {
    if (carmackIds.has(id)) crossReviewerDuplicates++;
  }

  const totalDurationMs =
    signals.length >= 2
      ? new Date(signals[signals.length - 1]!.receivedAt).getTime() -
        new Date(signals[0]!.receivedAt).getTime()
      : 0;

  const finalState = loop.state;
  const succeeded = !["blocked", "review_gate"].includes(finalState);

  return {
    totalSignals,
    fixCycles,
    maxFixCyclesBeforeBlock: fixCycles, // same as fixCycles for baseline
    totalDurationMs,
    convergenceRate,
    totalFindings,
    blockingFindings,
    uniqueRootCauses,
    signalToNoiseRatio,
    crossReviewerDuplicates,
    finalState,
    succeeded,
  };
}

// ---------------------------------------------------------------------------
// Gate event normalization
// ---------------------------------------------------------------------------

export function normalizeGateEvents({
  deepReviewRuns,
  carmackReviewRuns,
  ciGateRuns,
  reviewThreadGateRuns,
}: {
  deepReviewRuns: any[];
  carmackReviewRuns: any[];
  ciGateRuns: any[];
  reviewThreadGateRuns: any[];
}): EvalGateEvent[] {
  const events: EvalGateEvent[] = [];

  for (const run of deepReviewRuns) {
    events.push({
      index: 0,
      gateType: "deep_review",
      headSha: run.headSha,
      loopVersion: run.loopVersion,
      gatePassed: run.gatePassed,
      status: run.status,
      model: run.model ?? null,
      rawOutput: run.rawOutput,
      createdAt:
        run.createdAt instanceof Date
          ? run.createdAt.toISOString()
          : String(run.createdAt),
    });
  }

  for (const run of carmackReviewRuns) {
    events.push({
      index: 0,
      gateType: "carmack_review",
      headSha: run.headSha,
      loopVersion: run.loopVersion,
      gatePassed: run.gatePassed,
      status: run.status,
      model: run.model ?? null,
      rawOutput: run.rawOutput,
      createdAt:
        run.createdAt instanceof Date
          ? run.createdAt.toISOString()
          : String(run.createdAt),
    });
  }

  for (const run of ciGateRuns) {
    events.push({
      index: 0,
      gateType: "ci",
      headSha: run.headSha,
      loopVersion: run.loopVersion,
      gatePassed: run.gatePassed,
      status: run.status,
      model: null,
      rawOutput: {
        requiredChecks: run.requiredChecks,
        failingRequiredChecks: run.failingRequiredChecks,
        capabilityState: run.capabilityState,
        requiredCheckSource: run.requiredCheckSource,
      },
      createdAt:
        run.createdAt instanceof Date
          ? run.createdAt.toISOString()
          : String(run.createdAt),
    });
  }

  for (const run of reviewThreadGateRuns) {
    events.push({
      index: 0,
      gateType: "review_thread",
      headSha: run.headSha,
      loopVersion: run.loopVersion,
      gatePassed: run.gatePassed,
      status: run.status,
      model: null,
      rawOutput: {
        unresolvedThreadCount: run.unresolvedThreadCount,
        evaluationSource: run.evaluationSource,
      },
      createdAt:
        run.createdAt instanceof Date
          ? run.createdAt.toISOString()
          : String(run.createdAt),
    });
  }

  // Sort chronologically and assign indices
  events.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  events.forEach((e, i) => {
    e.index = i;
  });

  return events;
}

// ---------------------------------------------------------------------------
// Full fixture assembly
// ---------------------------------------------------------------------------

export function assembleFixture(params: {
  threadId: string;
  thread: RawThread;
  threadChat: RawThreadChat;
  loop: RawLoop;
  signals: EvalSignal[];
  gateEvents: EvalGateEvent[];
  deepFindings: EvalFinding[];
  carmackFindings: EvalFinding[];
  artifacts: EvalArtifact[];
  planTasks: EvalPlanTask[];
  userMessages: SerializedUserMessage[];
  planText: string;
}): EvalFixture {
  const {
    threadId,
    thread,
    threadChat,
    loop,
    signals,
    gateEvents,
    deepFindings,
    carmackFindings,
    artifacts,
    planTasks,
    userMessages,
    planText,
  } = params;

  const baselineMetrics = computeBaselineMetrics(
    signals,
    deepFindings,
    carmackFindings,
    loop,
  );

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    sourceThreadId: threadId,
    sourceThreadChatId: threadChat.id,
    thread: {
      name: thread.name,
      githubRepoFullName: thread.githubRepoFullName,
      repoBaseBranchName: thread.repoBaseBranchName,
      branchName: thread.branchName,
      sandboxProvider: thread.sandboxProvider,
      sandboxSize: thread.sandboxSize,
    },
    threadChat: {
      agent: threadChat.agent,
      agentVersion: threadChat.agentVersion,
      permissionMode: threadChat.permissionMode ?? "allowAll",
      userMessages,
    },
    loop: {
      planApprovalPolicy: loop.planApprovalPolicy,
      maxFixAttempts: loop.maxFixAttempts,
    },
    plan: planTasks.length > 0 ? { planText, tasks: planTasks } : null,
    signals,
    gateEvents,
    prodFindings: {
      deep: deepFindings,
      carmack: carmackFindings,
    },
    prodArtifacts: artifacts,
    baselineMetrics,
  };
}
