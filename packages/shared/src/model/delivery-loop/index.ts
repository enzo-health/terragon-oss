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

// guarded-state.ts (pure types and utilities only; DB functions removed with sdlcLoop table)
export {
  type StaleNoopReason,
  type SdlcGateLoopUpdateOutcome,
  isStaleNoop,
  fixAttemptIncrementEvents,
  normalizeCheckNames,
  resolveRequiredCheckSource,
} from "./guarded-state";

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
