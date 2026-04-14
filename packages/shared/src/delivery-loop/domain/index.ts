// workflow.ts
export {
  type WorkflowId,
  type SignalId,
  type CorrelationId,
  type DispatchId,
  type GitSha,
  type ThreadId,
  type PlanVersion,
  type GateKind,
  type ExecutionClass,
  type DispatchMechanism,
  type DispatchFailure,
  type ReviewSurfaceRef,
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
} from "./workflow";

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

// retry-policy.ts
export {
  type FailureCategory,
  type FailureClassification,
  classifyFailure,
  computeBackoffMs,
} from "./retry-policy";

// failure.ts
export {
  type DeliveryLoopFailureCategory,
  type DeliveryLoopRetryAction,
  DELIVERY_LOOP_FAILURE_ACTION_TABLE,
  type DaemonTerminalErrorCategory,
  classifyDaemonTerminalErrorCategory,
  mapDaemonTerminalCategoryToFailureCategory,
} from "./failure";

// failure-signature.ts
export {
  type FailureSignature,
  type FailureSignatureMap,
  type FailureLane,
  type FailureClassifyInput,
  type CircuitBreakerPolicy,
  hashFailureMessage,
  makeSignatureKey,
  extractFailureSignature,
  isSameSignature,
  shouldTripCircuitBreaker,
  isInfrastructureSignature,
  isInfrastructureFailure,
  classifyFailureLane,
  getPolicyForSignature,
} from "./failure-signature";
