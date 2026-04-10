/**
 * Dynamic imports for @leo/shared modules.
 *
 * Follows the same pattern as test-delivery-loop-e2e.ts to avoid
 * transitive Next.js / broadcast-server dependencies.
 */

import type { DB } from "@leo/shared/db";

export async function loadSharedModules() {
  const { createDb } = await import("@leo/shared/db");
  const {
    enrollSdlcLoopForThread,
    createPlanArtifactForLoop,
    approvePlanArtifactForLoop,
    replacePlanTasksForArtifact,
    markPlanTasksCompletedByAgent,
    verifyPlanTaskCompletionForHead,
    transitionSdlcLoopState,
    getActiveSdlcLoopForThread,
    createImplementationArtifactForHead,
    createReviewBundleArtifactForHead,
    createUiSmokeArtifactForHead,
    createPrLinkArtifact,
    createBabysitEvaluationArtifactForHead,
    persistSdlcCiGateEvaluation,
    persistDeepReviewGateResult,
    persistCarmackReviewGateResult,
    buildSdlcCanonicalCause,
    getLatestAcceptedArtifact,
  } = await import("@leo/shared/model/delivery-loop");

  const {
    claimNextUnprocessedSignal,
    completeSignalClaim,
    evaluateBabysitCompletionForHead,
  } = await import("@leo/shared/model/signal-inbox-core");

  const schema = await import("@leo/shared/db/schema");
  const { eq } = await import("drizzle-orm");
  const { nanoid } = await import("nanoid/non-secure");

  return {
    createDb,
    schema,
    eq,
    nanoid,
    enrollSdlcLoopForThread,
    createPlanArtifactForLoop,
    approvePlanArtifactForLoop,
    replacePlanTasksForArtifact,
    markPlanTasksCompletedByAgent,
    verifyPlanTaskCompletionForHead,
    transitionSdlcLoopState,
    getActiveSdlcLoopForThread,
    createImplementationArtifactForHead,
    createReviewBundleArtifactForHead,
    createUiSmokeArtifactForHead,
    createPrLinkArtifact,
    getLatestAcceptedArtifact,
    createBabysitEvaluationArtifactForHead,
    persistSdlcCiGateEvaluation,
    persistDeepReviewGateResult,
    persistCarmackReviewGateResult,
    buildSdlcCanonicalCause,
    claimNextUnprocessedSignal,
    completeSignalClaim,
    evaluateBabysitCompletionForHead,
  };
}

export type SharedModules = Awaited<ReturnType<typeof loadSharedModules>>;
export type { DB };
