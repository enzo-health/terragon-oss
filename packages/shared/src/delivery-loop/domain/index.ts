// workflow.ts
export {
  type WorkflowId,
  type SignalId,
  type CorrelationId,
  type DispatchId,
  type GitSha,
  type ThreadId,
  type PlanVersion,
  type WorkflowState,
  type GateKind,
  type DispatchSubState,
  type ExecutionClass,
  type DispatchMechanism,
  type DispatchFailure,
  type ReviewSurfaceRef,
  type ResumableWorkflowState,
  type TerminationReason,
  type StopReason,
  type CompletionOutcome,
  type ManualFixIssue,
  type OperatorActionReason,
  type HumanWaitReason,
  type PendingAction,
  type GateSubState,
  type ReviewGateSnapshot,
  type CiGateSnapshot,
  type UiGateSnapshot,
  type WorkflowCommon,
  type DeliveryWorkflow,
  isTerminalState,
  isActiveState,
  isHumanWaitState,
} from "./workflow";

// events.ts
export {
  type LoopEvent,
  type LoopEventContext,
  type PublicationTarget,
  type DeliveryWorkflowEvent,
  type GateVerdict,
} from "./events";

// signals.ts
export {
  type DaemonCompletionResult,
  type DaemonFailure,
  type DaemonProgress,
  type CiEvaluation,
  type ReviewEvaluation,
  type DaemonSignal,
  type GitHubSignal,
  type HumanSignal,
  type TimerSignal,
  type DeliverySignal,
} from "./signals";

// transitions.ts
export {
  reduceWorkflow,
  shouldResetFixAttemptCount,
  derivePendingAction,
} from "./transitions";

// work-items.ts
export {
  type WorkItemStatus,
  type SelectedAgent,
  type TransportMode,
  type RetryRequest,
  type DeliveryWorkItem,
} from "./work-items";

// retry-policy.ts
export {
  type FailureCategory,
  type FailureClassification,
  classifyFailure,
  computeBackoffMs,
} from "./retry-policy";

// observability.ts
export {
  type StuckReason,
  type DegradedReason,
  type DeliveryWorkflowHealth,
  type DeliveryIncident,
  deriveHealth,
  shouldOpenIncident,
  type ReplayEntry,
} from "./observability";

// correlation.ts
export { generateCorrelationId } from "./correlation";

// logging.ts
export { type DeliveryLoopLogContext, buildLogContext } from "./logging";
