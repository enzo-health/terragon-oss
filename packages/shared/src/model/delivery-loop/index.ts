// ────────────────────────────────────────────────────────────────
// Barrel — re-export every module in the delivery-loop directory.
// ────────────────────────────────────────────────────────────────

// types.ts
export {
  type DeliveryLoopState,
  type SdlcLoopState,
  type DeliveryLoopSelectedAgent,
  type DeliveryLoopDispatchablePhase,
  type DeliveryLoopResumableState,
  type DeliveryLoopDispatchStatus,
  type DeliveryLoopBlockedReasonCategory,
  type DeliveryLoopImplementationExecution,
  type DeliveryLoopGateExecution,
  type DeliveryLoopBlockedState,
  type DeliveryLoopSnapshot,
  type DeliveryLoopCompanionFields,
  deliveryLoopCompanionFieldDefaults,
  assertNever,
  normalizeBlockedReasonCategory,
  resolveBlockedResumeTarget,
  coerceDeliveryLoopResumableState,
  createPlanningSnapshot,
  createImplementingSnapshot,
  createReviewGateSnapshot,
  createCiGateSnapshot,
  createUiGateSnapshot,
  createAwaitingPrLinkSnapshot,
  createBabysittingSnapshot,
  createBlockedSnapshot,
  createDoneSnapshot,
  createStoppedSnapshot,
  createTerminatedPrClosedSnapshot,
  createTerminatedPrMergedSnapshot,
  buildDeliveryLoopSnapshot,
  buildDeliveryLoopCompanionFields,
  buildPersistedDeliveryLoopSnapshot,
  DELIVERY_LOOP_CANONICAL_STATES,
  DELIVERY_LOOP_CANONICAL_STATE_SET,
  legacyStateMapping,
} from "./types";

// state-machine.ts
export {
  getEffectiveDeliveryLoopPhase,
  reducePersistedDeliveryLoopState,
  type DeliveryLoopTransitionEvent,
  type DeliveryLoopTransitionResult,
  mapSdlcTransitionEventToDeliveryLoopTransition,
  resolveDeliveryLoopNextState,
  reduceDeliveryLoopSnapshot,
} from "./state-machine";

// state-constants.ts
export {
  activeSdlcLoopStateList,
  activeSdlcLoopStateSet,
  terminalSdlcLoopStateList,
  terminalSdlcLoopStateSet,
  type DeliveryLoopFailureCategory,
  type DeliveryLoopRetryAction,
  DELIVERY_LOOP_FAILURE_ACTION_TABLE,
  type DeliveryLoopExecutionClass,
  type DeliveryLoopDispatchMechanism,
  type DeliveryLoopDispatchIntent,
  type SdlcLoopTransitionEvent,
  isIncompletePlanTaskStatus,
  isNonBlockingTerminalPlanTaskStatus,
  type SdlcLoopArtifactPointerField,
  phaseToLoopPointerColumn,
  isSdlcLoopTerminalState,
  type SdlcGuardrailReasonCode,
  evaluateSdlcLoopGuardrails,
} from "./state-constants";

// canonical-cause.ts
export {
  SDLC_CAUSE_IDENTITY_VERSION,
  type SdlcCanonicalCauseInput,
  type SdlcCanonicalCause,
  buildSdlcCanonicalCause,
} from "./canonical-cause";

// enrollment.ts
export {
  getActiveSdlcLoopForGithubPRAndUser,
  getActiveSdlcLoopsForGithubPR,
  getPreferredActiveSdlcLoopForGithubPRAndUser,
  getActiveSdlcLoopForGithubPR,
  transitionActiveSdlcLoopsForGithubPREvent,
  enrollSdlcLoopForGithubPR,
  enrollSdlcLoopForThread,
  linkSdlcLoopToGithubPRForThread,
  getActiveSdlcLoopForThread,
} from "./enrollment";

// artifacts.ts
export {
  getLatestAcceptedArtifact,
  createPlanArtifactForLoop,
  approvePlanArtifactForLoop,
  replacePlanTasksForArtifact,
  markPlanTasksCompletedByAgent,
  verifyPlanTaskCompletionForHead,
  createImplementationArtifactForHead,
  createReviewBundleArtifactForHead,
  createUiSmokeArtifactForHead,
  createPrLinkArtifact,
  createBabysitEvaluationArtifactForHead,
  type SdlcTransitionWithArtifactOutcome,
  transitionSdlcLoopStateWithArtifact,
} from "./artifacts";

// lease.ts
export {
  type SdlcLoopLeaseAcquireResult,
  acquireSdlcLoopLease,
  type SdlcLoopLeaseRefreshResult,
  refreshSdlcLoopLease,
  releaseSdlcLoopLease,
} from "./lease";

// github-pr-references.ts
export {
  type SdlcOutboxErrorClass,
  persistSdlcCanonicalStatusCommentReference,
  clearSdlcCanonicalStatusCommentReference,
  persistSdlcCanonicalCheckRunReference,
} from "./github-pr-references";

// webhook-delivery.ts
export {
  GITHUB_WEBHOOK_CLAIM_TTL_MS,
  type GithubWebhookDeliveryClaimOutcome,
  type GithubWebhookDeliveryClaimResult,
  getGithubWebhookClaimHttpStatus,
  claimGithubWebhookDelivery,
  completeGithubWebhookDelivery,
  releaseGithubWebhookDeliveryClaim,
} from "./webhook-delivery";

// guarded-state.ts
export {
  type StaleNoopReason,
  type SdlcGateLoopUpdateOutcome,
  isStaleNoop,
  fixAttemptIncrementEvents,
  persistGuardedGateLoopState,
  transitionSdlcLoopState,
  normalizeCheckNames,
  resolveRequiredCheckSource,
} from "./guarded-state";

// ci-gate-persistence.ts
export {
  type PersistSdlcCiGateEvaluationResult,
  toCiGateVerdict,
  persistSdlcCiGateEvaluation,
} from "./ci-gate-persistence";

// review-thread-gate-persistence.ts
export {
  type PersistSdlcReviewThreadGateResult,
  toReviewThreadGateVerdict,
  persistSdlcReviewThreadGateEvaluation,
} from "./review-thread-gate-persistence";

// review-gate-persistence.ts
export {
  reviewFindingSchema,
  reviewGateOutputSchema,
  type ReviewGateOutput,
  type PersistReviewGateResult,
  type DeepReviewGateOutput,
  type CarmackReviewGateOutput,
  type PersistDeepReviewGateResult,
  type PersistCarmackReviewGateResult,
  toReviewGateVerdict,
  deepReviewFindingSchema,
  deepReviewGateOutputSchema,
  carmackReviewFindingSchema,
  carmackReviewGateOutputSchema,
  parseReviewGateOutput,
  parseDeepReviewGateOutput,
  parseCarmackReviewGateOutput,
  persistDeepReviewGateResult,
  getUnresolvedBlockingDeepReviewFindings,
  resolveDeepReviewFinding,
  shouldQueueFollowUpForDeepReview,
  persistCarmackReviewGateResult,
  getUnresolvedBlockingCarmackReviewFindings,
  resolveCarmackReviewFinding,
  shouldQueueFollowUpForCarmackReview,
  canRunCarmackReviewForHeadSha,
} from "./review-gate-persistence";

// dispatch-intent.ts
export {
  type CreateDispatchIntentInput,
  toDispatchIntentStatus,
  fromDispatchIntentStatus,
  createDispatchIntent,
  markDispatchIntentDispatched,
  markDispatchIntentAcknowledged,
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
  getLatestDispatchIntentForLoop,
  getDispatchIntentByRunId,
  getStalledDispatchIntents,
} from "./dispatch-intent";
