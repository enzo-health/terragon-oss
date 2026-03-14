// ────────────────────────────────────────────────────────────────
// Barrel — re-export every module in the delivery-loop directory.
// ────────────────────────────────────────────────────────────────

export * from "./types";
export * from "./state-machine";
export * from "./state-constants";
export * from "./legacy-transitions";
export * from "./enrollment";
export * from "./artifacts";
export * from "./lease";
export * from "./outbox";
export * from "./video-capture";
export * from "./parity-metrics";
export * from "./webhook-delivery";
export * from "./guarded-state";
export * from "./ci-gate-persistence";
export * from "./review-thread-gate-persistence";
export * from "./review-gate-persistence";
export * from "./dispatch-intent";

// ────────────────────────────────────────────────────────────────
// Delivery Loop aliases — new canonical names for Sdlc-prefixed exports.
// Consumers should migrate to these names over time.
// ────────────────────────────────────────────────────────────────

// Type aliases
// DeliveryLoopTransitionEvent is a canonical type exported from state-machine.
import type {
  SdlcCanonicalCauseInput,
  SdlcCanonicalCause,
} from "./legacy-transitions";
import type { SdlcGuardrailReasonCode } from "./state-constants";
import type { SdlcTransitionWithArtifactOutcome } from "./artifacts";
import type { SdlcLoopLeaseAcquireResult } from "./lease";
import type { SdlcOutboxErrorClass } from "./outbox";
import type { SdlcParityBucketStats } from "./parity-metrics";
import type { SdlcGateLoopUpdateOutcome } from "./guarded-state";

export type DeliveryLoopCanonicalCauseInput = SdlcCanonicalCauseInput;
export type DeliveryLoopCanonicalCause = SdlcCanonicalCause;
export type DeliveryLoopGuardrailReasonCode = SdlcGuardrailReasonCode;
export type DeliveryLoopTransitionWithArtifactOutcome =
  SdlcTransitionWithArtifactOutcome;
export type DeliveryLoopLeaseAcquireResult = SdlcLoopLeaseAcquireResult;
export type DeliveryLoopOutboxErrorClass = SdlcOutboxErrorClass;
export type DeliveryLoopParityBucketStats = SdlcParityBucketStats;
export type DeliveryLoopGateUpdateOutcome = SdlcGateLoopUpdateOutcome;

// Constant aliases
import { SDLC_CAUSE_IDENTITY_VERSION } from "./legacy-transitions";
export const DELIVERY_LOOP_CAUSE_IDENTITY_VERSION = SDLC_CAUSE_IDENTITY_VERSION;

// Function aliases
import {
  isSdlcLoopTerminalState,
  evaluateSdlcLoopGuardrails,
} from "./state-constants";
import {
  resolveSdlcLoopNextState,
  getSdlcOutboxSupersessionGroup,
  buildSdlcCanonicalCause,
} from "./legacy-transitions";
import {
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
import { transitionSdlcLoopStateWithArtifact } from "./artifacts";
import { acquireSdlcLoopLease, releaseSdlcLoopLease } from "./lease";
import {
  enqueueSdlcOutboxAction,
  claimNextSdlcOutboxActionForExecution,
  completeSdlcOutboxActionExecution,
} from "./outbox";
import { transitionSdlcLoopState } from "./guarded-state";
import { evaluateSdlcParitySlo } from "./parity-metrics";

export const isDeliveryLoopTerminalState = isSdlcLoopTerminalState;
export const resolveLegacySdlcLoopNextState = resolveSdlcLoopNextState;
export const getDeliveryLoopOutboxSupersessionGroup =
  getSdlcOutboxSupersessionGroup;
export const buildDeliveryLoopCanonicalCause = buildSdlcCanonicalCause;
export const evaluateDeliveryLoopGuardrails = evaluateSdlcLoopGuardrails;
export const getActiveDeliveryLoopForGithubPRAndUser =
  getActiveSdlcLoopForGithubPRAndUser;
export const getActiveDeliveryLoopsForGithubPR = getActiveSdlcLoopsForGithubPR;
export const getPreferredActiveDeliveryLoopForGithubPRAndUser =
  getPreferredActiveSdlcLoopForGithubPRAndUser;
export const getActiveDeliveryLoopForGithubPR = getActiveSdlcLoopForGithubPR;
export const transitionActiveDeliveryLoopsForGithubPREvent =
  transitionActiveSdlcLoopsForGithubPREvent;
export const enrollDeliveryLoopForGithubPR = enrollSdlcLoopForGithubPR;
export const enrollDeliveryLoopForThread = enrollSdlcLoopForThread;
export const linkDeliveryLoopToGithubPRForThread =
  linkSdlcLoopToGithubPRForThread;
export const getActiveDeliveryLoopForThread = getActiveSdlcLoopForThread;
export const transitionDeliveryLoopStateWithArtifact =
  transitionSdlcLoopStateWithArtifact;
export const acquireDeliveryLoopLease = acquireSdlcLoopLease;
export const releaseDeliveryLoopLease = releaseSdlcLoopLease;
export const enqueueDeliveryLoopOutboxAction = enqueueSdlcOutboxAction;
export const claimNextDeliveryLoopOutboxActionForExecution =
  claimNextSdlcOutboxActionForExecution;
export const completeDeliveryLoopOutboxActionExecution =
  completeSdlcOutboxActionExecution;
export const transitionDeliveryLoopState = transitionSdlcLoopState;
export const evaluateDeliveryLoopParitySlo = evaluateSdlcParitySlo;
