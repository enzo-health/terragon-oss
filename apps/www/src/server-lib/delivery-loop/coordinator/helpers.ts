import type {
  DeliveryWorkflow,
  WorkflowCommon,
  GateKind,
  GitSha,
} from "@terragon/shared/delivery-loop/domain/workflow";

/** Extract the head SHA from a workflow if the state carries one. */
export function extractHeadSha(workflow: DeliveryWorkflow): GitSha | null {
  if (
    workflow.kind === "gating" ||
    workflow.kind === "awaiting_pr" ||
    workflow.kind === "babysitting"
  ) {
    return workflow.headSha;
  }
  return null;
}

/** Extract the gate sub-state kind, or null if not in gating. */
export function extractGateKind(workflow: DeliveryWorkflow): GateKind | null {
  if (workflow.kind === "gating") return workflow.gate.kind;
  return null;
}

/** Extract the review surface JSON for babysitting workflows. */
export function extractReviewSurface(
  workflow: DeliveryWorkflow,
): Record<string, unknown> | null {
  if (workflow.kind === "babysitting") {
    return workflow.reviewSurface as unknown as Record<string, unknown>;
  }
  return null;
}

/**
 * Exhaustive record keyed by every WorkflowCommon field (plus discriminant
 * "kind"). Adding a field to WorkflowCommon without listing it here causes
 * a TypeScript error because Record<K, true> requires all keys to be present.
 */
const WORKFLOW_COMMON_KEY_MAP: Record<keyof WorkflowCommon | "kind", true> = {
  workflowId: true,
  threadId: true,
  generation: true,
  version: true,
  fixAttemptCount: true,
  maxFixAttempts: true,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
  kind: true,
};
const WORKFLOW_COMMON_KEYS: ReadonlySet<string> = new Set(
  Object.keys(WORKFLOW_COMMON_KEY_MAP),
);

/**
 * Serialize a DeliveryWorkflow to the stateJson blob stored in the DB.
 * Strips WorkflowCommon fields, keeping only state-specific data.
 */
export function serializeWorkflowState(
  workflow: DeliveryWorkflow,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflow)) {
    if (!WORKFLOW_COMMON_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
