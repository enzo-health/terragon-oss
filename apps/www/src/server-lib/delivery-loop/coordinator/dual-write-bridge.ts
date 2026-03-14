/**
 * Dual-write bridge: wraps the v2 coordinator tick to write to BOTH
 * old (sdlcLoop) and new (delivery_workflow) tables.
 *
 * During migration the old table remains the source of truth.
 * The new table is kept in sync for validation.
 */
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type { SdlcLoopState } from "@terragon/shared/db/types";
import type {
  WorkflowId,
  CorrelationId,
  WorkflowState,
  GateKind,
  ResumableWorkflowState,
} from "@terragon/shared/delivery-loop/domain/workflow";
import { eq } from "drizzle-orm";

import { runCoordinatorTick, type CoordinatorTickResult } from "./tick";

// ---------------------------------------------------------------------------
// V2 → V1 state mapping
// ---------------------------------------------------------------------------

/**
 * Maps new v2 WorkflowState to old v1 SdlcLoopState.
 * Used during dual-write to keep the old table in sync.
 */
export function mapV2StateToV1(
  v2State: WorkflowState,
  gate?: GateKind | string | null,
  terminationKind?: string | null,
): SdlcLoopState {
  switch (v2State) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "gating":
      switch (gate) {
        case "review":
          return "review_gate";
        case "ci":
          return "ci_gate";
        case "ui":
          return "ui_gate";
        default:
          return "review_gate";
      }
    case "awaiting_pr":
      return "awaiting_pr_link";
    case "babysitting":
      return "babysitting";
    case "awaiting_plan_approval":
      return "blocked";
    case "awaiting_manual_fix":
      return "blocked";
    case "awaiting_operator_action":
      return "blocked";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "terminated":
      return terminationKind === "pr_merged"
        ? "terminated_pr_merged"
        : "terminated_pr_closed";
    default:
      // Defensive: return implementing for unrecognized states
      return "implementing";
  }
}

/**
 * Maps v2 human-wait states back to v1 blockedFromState.
 */
export function mapV2BlockedFromState(
  v2State: WorkflowState,
  stateJson: Record<string, unknown> | null,
): SdlcLoopState | null {
  if (v2State === "awaiting_plan_approval") {
    return "planning";
  }
  if (
    v2State === "awaiting_manual_fix" ||
    v2State === "awaiting_operator_action"
  ) {
    const resumableFrom = stateJson?.resumableFrom as
      | ResumableWorkflowState
      | undefined;
    if (resumableFrom) {
      switch (resumableFrom.kind) {
        case "planning":
          return "planning";
        case "implementing":
          return "implementing";
        case "gating":
          return `${resumableFrom.gate}_gate` as SdlcLoopState;
        case "awaiting_pr":
          return "awaiting_pr_link";
        case "babysitting":
          return "babysitting";
      }
    }
    return "implementing";
  }
  return null;
}

/**
 * Extract termination kind from the workflow's stateJson.
 */
function extractTerminationKind(
  v2State: WorkflowState,
  stateJson: Record<string, unknown> | null,
): string | null {
  if (v2State !== "terminated") return null;
  const reason = stateJson?.reason as { kind?: string } | undefined;
  return reason?.kind ?? null;
}

// ---------------------------------------------------------------------------
// Dual-write coordinator tick
// ---------------------------------------------------------------------------

export type DualWriteTickResult = CoordinatorTickResult & {
  v1SyncResult: "synced" | "skipped" | "error";
};

export async function runDualWriteCoordinatorTick(params: {
  db: DB;
  workflowId: WorkflowId;
  correlationId: CorrelationId;
  sdlcLoopId: string;
  claimToken?: string;
  now?: Date;
}): Promise<DualWriteTickResult> {
  // 1. Run the v2 coordinator tick (writes to new tables)
  const result = await runCoordinatorTick({
    db: params.db,
    workflowId: params.workflowId,
    correlationId: params.correlationId,
    claimToken: params.claimToken,
    now: params.now,
  });

  // 2. If state changed, also update the old sdlcLoop table
  if (!result.transitioned || result.stateAfter === result.stateBefore) {
    return { ...result, v1SyncResult: "skipped" };
  }

  try {
    // Read back the v2 workflow to get stateJson for blockedFromState derivation
    const { getWorkflow } = await import(
      "@terragon/shared/delivery-loop/store/workflow-store"
    );
    const workflowRow = await getWorkflow({
      db: params.db,
      workflowId: params.workflowId,
    });
    const stateJson = (workflowRow?.stateJson ?? null) as Record<
      string,
      unknown
    > | null;

    const v2State = result.stateAfter as WorkflowState;
    const gateAfter = extractGateKindFromState(v2State, stateJson);
    const terminationKind = extractTerminationKind(v2State, stateJson);
    const v1State = mapV2StateToV1(v2State, gateAfter, terminationKind);
    const blockedFromState = mapV2BlockedFromState(v2State, stateJson);

    const updateValues: Record<string, unknown> = {
      state: v1State,
      updatedAt: params.now ?? new Date(),
    };
    if (blockedFromState !== null) {
      updateValues.blockedFromState = blockedFromState;
    }

    await params.db
      .update(schema.sdlcLoop)
      .set(updateValues)
      .where(eq(schema.sdlcLoop.id, params.sdlcLoopId));

    return { ...result, v1SyncResult: "synced" };
  } catch (error) {
    console.error("[dual-write-bridge] v1 sync failed", {
      workflowId: params.workflowId,
      sdlcLoopId: params.sdlcLoopId,
      error,
    });
    return { ...result, v1SyncResult: "error" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractGateKindFromState(
  v2State: WorkflowState,
  stateJson: Record<string, unknown> | null,
): GateKind | null {
  if (v2State !== "gating") return null;
  const gate = stateJson?.gate as { kind?: string } | undefined;
  return (gate?.kind as GateKind) ?? null;
}
