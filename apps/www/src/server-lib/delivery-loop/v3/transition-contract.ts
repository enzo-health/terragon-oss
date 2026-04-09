import type {
  EffectSpec,
  LoopEvent,
  WorkflowHead,
  WorkflowState,
} from "./types";

export const CONTRACT_NOW = new Date("2026-03-18T00:00:00.000Z");

type ContractWorkflowState = Exclude<
  WorkflowState,
  "awaiting_implementation_acceptance"
>;

export function makeContractHead(state: ContractWorkflowState): WorkflowHead {
  const base: WorkflowHead = {
    workflowId: "wf-1",
    threadId: "thread-1",
    generation: 1,
    version: 2,
    state,
    activeGate: null,
    headSha: null,
    activeRunId: null,
    activeRunSeq: null,
    leaseExpiresAt: null,
    lastTerminalRunSeq: null,
    fixAttemptCount: 0,
    infraRetryCount: 0,
    maxFixAttempts: 6,
    maxInfraRetries: 10,
    blockedReason: null,
    createdAt: CONTRACT_NOW,
    updatedAt: CONTRACT_NOW,
    lastActivityAt: CONTRACT_NOW,
  };

  switch (state) {
    case "implementing":
      return { ...base, activeRunSeq: 1 };
    case "gating_review":
      return {
        ...base,
        activeRunId: "r-1",
        activeRunSeq: 1,
        headSha: "abc123",
        activeGate: "review",
      };
    case "gating_ci":
      return {
        ...base,
        activeRunId: "r-1",
        activeRunSeq: 1,
        headSha: "abc123",
        activeGate: "ci",
      };
    case "awaiting_pr_creation":
      return {
        ...base,
        activeRunSeq: 1,
        headSha: "abc123",
        blockedReason: "Awaiting PR creation",
      };
    case "awaiting_pr_lifecycle":
      return {
        ...base,
        headSha: "abc123",
        lastTerminalRunSeq: 1,
      };
    case "awaiting_manual_fix":
      return { ...base, blockedReason: "test" };
    case "awaiting_operator_action":
      return { ...base, blockedReason: "test" };
    default:
      return base;
  }
}

export const ALL_STATES: ContractWorkflowState[] = [
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
  "awaiting_pr_creation",
  "awaiting_pr_lifecycle",
  "awaiting_manual_fix",
  "awaiting_operator_action",
  "done",
  "stopped",
  "terminated",
];

export const NON_TERMINAL_STATES: ContractWorkflowState[] = [
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
  "awaiting_pr_creation",
  "awaiting_pr_lifecycle",
  "awaiting_manual_fix",
  "awaiting_operator_action",
];

export const TERMINAL_STATES = new Set<WorkflowState>([
  "done",
  "stopped",
  "terminated",
]);

export const ALL_CANONICAL_EVENTS: LoopEvent[] = [
  { type: "bootstrap" },
  { type: "planning_run_completed" },
  { type: "plan_completed" },
  { type: "plan_failed", reason: "test" },
  {
    type: "dispatch_queued",
    runId: "r-1",
    ackDeadlineAt: new Date("2030-01-01"),
  },
  { type: "dispatch_claimed", runId: "r-1" },
  { type: "dispatch_accepted", runId: "r-1" },
  {
    type: "dispatch_sent",
    runId: "r-1",
    ackDeadlineAt: new Date("2030-01-01"),
  },
  { type: "dispatch_acked", runId: "r-1" },
  { type: "dispatch_ack_timeout", runId: "r-1" },
  { type: "run_completed", runId: "r-1", headSha: "abc123" },
  { type: "run_failed", runId: "r-1", message: "err", category: null },
  { type: "gate_review_passed", runId: "r-1", prNumber: 1 },
  { type: "gate_review_failed", runId: "r-1", runSeq: 1, reason: "test" },
  { type: "gate_ci_passed", headSha: "abc123" },
  { type: "gate_ci_failed", headSha: "abc123", reason: "test" },
  { type: "pr_linked", prNumber: 1 },
  { type: "resume_requested" },
  { type: "stop_requested" },
  { type: "pr_closed", merged: false },
];

export type TransitionExpectation = {
  target: WorkflowState | "noop" | "stay";
  effects?: TransitionEffectKind[];
};

type TransitionEventType = LoopEvent["type"];
type TransitionEffectKind = EffectSpec["kind"];
type TransitionRow = Record<TransitionEventType, TransitionExpectation>;
type TransitionMatrix = Record<ContractWorkflowState, TransitionRow>;

const EVENT_TYPES: TransitionEventType[] = ALL_CANONICAL_EVENTS.map(
  (event) => event.type,
);

function makeNoopTransitionRow(): TransitionRow {
  const row = {} as TransitionRow;
  for (const type of EVENT_TYPES) {
    row[type] = {
      target: "noop",
      effects: [],
    };
  }
  return row;
}

export const EXPECTED_TRANSITIONS: TransitionMatrix = {
  planning: {
    bootstrap: {
      target: "stay",
      effects: ["dispatch_implementing", "publish_status"],
    },
    planning_run_completed: {
      target: "stay",
      effects: ["create_plan_artifact", "publish_status"],
    },
    plan_completed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    plan_failed: {
      target: "awaiting_manual_fix",
      effects: ["publish_status"],
    },
    dispatch_queued: {
      target: "stay",
      effects: ["run_lease_expiry_check"],
    },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  implementing: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: {
      target: "stay",
      effects: ["run_lease_expiry_check"],
    },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    run_completed: {
      target: "gating_review",
      effects: ["dispatch_gate_review", "publish_status"],
    },
    run_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  gating_review: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: { target: "noop", effects: [] },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_review_passed: {
      target: "gating_ci",
      effects: ["gate_staleness_check", "publish_status"],
    },
    gate_review_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  gating_ci: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: { target: "noop", effects: [] },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: {
      target: "awaiting_pr_lifecycle",
      effects: ["publish_status"],
    },
    gate_ci_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  awaiting_pr_creation: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: { target: "noop", effects: [] },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: {
      target: "gating_ci",
      effects: ["gate_staleness_check", "publish_status"],
    },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  awaiting_pr_lifecycle: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: { target: "noop", effects: [] },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  awaiting_manual_fix: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: { target: "noop", effects: [] },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  awaiting_operator_action: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_queued: { target: "noop", effects: [] },
    dispatch_claimed: { target: "noop", effects: [] },
    dispatch_accepted: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  done: makeNoopTransitionRow(),
  stopped: makeNoopTransitionRow(),
  terminated: makeNoopTransitionRow(),
};

export type BranchTransitionCase = {
  name: string;
  head: WorkflowHead;
  event: LoopEvent;
  expectedState: WorkflowState;
  expectedVersionDelta: 0 | 1;
  expectedEffects: TransitionEffectKind[];
};

export const BRANCH_CASES: BranchTransitionCase[] = [
  {
    name: "planning + bootstrap -> stay",
    head: makeContractHead("planning"),
    event: { type: "bootstrap" },
    expectedState: "planning",
    expectedVersionDelta: 1,
    expectedEffects: ["dispatch_implementing", "publish_status"],
  },
  {
    name: "planning + plan_completed -> implementing",
    head: makeContractHead("planning"),
    event: { type: "plan_completed" },
    expectedState: "implementing",
    expectedVersionDelta: 1,
    expectedEffects: ["dispatch_implementing", "publish_status"],
  },
  {
    name: "planning + dispatch_queued -> stay",
    head: {
      ...makeContractHead("planning"),
      activeRunSeq: 1,
    },
    event: {
      type: "dispatch_queued",
      runId: "r-1",
      ackDeadlineAt: new Date("2030-01-01"),
    },
    expectedState: "planning",
    expectedVersionDelta: 1,
    expectedEffects: ["run_lease_expiry_check"],
  },
  {
    name: "planning + run_failed -> retry planning",
    head: {
      ...makeContractHead("planning"),
      activeRunId: "r-1",
      activeRunSeq: 1,
    },
    event: {
      type: "run_failed",
      runId: "r-1",
      runSeq: 1,
      message: "sandbox missing",
      category: "sandbox_error",
      lane: "infra",
    },
    expectedState: "planning",
    expectedVersionDelta: 1,
    expectedEffects: ["dispatch_implementing", "publish_status"],
  },
  {
    name: "implementing + dispatch_queued -> stay",
    head: {
      ...makeContractHead("implementing"),
      activeRunId: "r-1",
    },
    event: {
      type: "dispatch_queued",
      runId: "r-1",
      ackDeadlineAt: new Date("2030-01-01"),
    },
    expectedState: "implementing",
    expectedVersionDelta: 1,
    expectedEffects: ["run_lease_expiry_check"],
  },
  {
    name: "implementing(activeRunId=null) + dispatch_claimed -> noop",
    head: makeContractHead("implementing"),
    event: { type: "dispatch_claimed", runId: "r-2" },
    expectedState: "implementing",
    expectedVersionDelta: 0,
    expectedEffects: [],
  },

  {
    name: "implementing(activeRunId=null) + dispatch_accepted -> noop",
    head: {
      ...makeContractHead("implementing"),
      activeRunId: null,
    },
    event: { type: "dispatch_accepted", runId: "r-2" },
    expectedState: "implementing",
    expectedVersionDelta: 0,
    expectedEffects: [],
  },
  {
    name: "gating_review + gate_review_passed(prNumber=null) -> awaiting_pr_creation",
    head: makeContractHead("gating_review"),
    event: { type: "gate_review_passed", runId: "r-1", prNumber: null },
    expectedState: "awaiting_pr_creation",
    expectedVersionDelta: 1,
    expectedEffects: ["ensure_pr", "publish_status"],
  },
  {
    name: "gating_review + gate_review_passed(prNumber=1) -> gating_ci",
    head: makeContractHead("gating_review"),
    event: { type: "gate_review_passed", runId: "r-1", prNumber: 1 },
    expectedState: "gating_ci",
    expectedVersionDelta: 1,
    expectedEffects: ["gate_staleness_check", "publish_status"],
  },
  {
    name: "awaiting_pr_creation ignores blockedReason for pr_linked transition",
    head: {
      ...makeContractHead("awaiting_pr_creation"),
      blockedReason: "stale-non-contract-reason",
    },
    event: { type: "pr_linked", prNumber: 7 },
    expectedState: "gating_ci",
    expectedVersionDelta: 1,
    expectedEffects: ["gate_staleness_check", "publish_status"],
  },
  {
    name: "awaiting_pr_creation + pr_linked(prNumber=null) -> noop",
    head: makeContractHead("awaiting_pr_creation"),
    event: { type: "pr_linked", prNumber: null },
    expectedState: "awaiting_pr_creation",
    expectedVersionDelta: 0,
    expectedEffects: [],
  },
  {
    name: "awaiting_pr_lifecycle + pr_linked -> noop",
    head: makeContractHead("awaiting_pr_lifecycle"),
    event: { type: "pr_linked", prNumber: 11 },
    expectedState: "awaiting_pr_lifecycle",
    expectedVersionDelta: 0,
    expectedEffects: [],
  },
  {
    name: "gating_ci + gate_ci_passed(correlated headSha) -> awaiting_pr_lifecycle",
    head: makeContractHead("gating_ci"),
    event: { type: "gate_ci_passed", headSha: "abc123" },
    expectedState: "awaiting_pr_lifecycle",
    expectedVersionDelta: 1,
    expectedEffects: ["publish_status"],
  },
  {
    name: "gating_ci + gate_ci_passed(stale headSha) -> noop",
    head: makeContractHead("gating_ci"),
    event: { type: "gate_ci_passed", headSha: "stale-sha" },
    expectedState: "gating_ci",
    expectedVersionDelta: 0,
    expectedEffects: [],
  },
];
