/**
 * Enrollment bridge: when a new v1 sdlcLoop is enrolled, also create
 * a corresponding v2 delivery_workflow row. Idempotent — calling
 * multiple times for the same thread will not create duplicates.
 *
 * Design note: v2 workflows are resolved by threadId (one active per
 * thread), not by v1 sdlcLoopId. This is intentional — the system
 * supports only one active workflow per thread. If a thread is
 * re-enrolled with a new loop, the old workflow should be terminated
 * first. A direct loop↔workflow mapping table is deferred until
 * multi-generation support is needed.
 */
import { desc, eq } from "drizzle-orm";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type { SdlcLoopState } from "@terragon/shared/db/types";
import type { WorkflowState } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  createWorkflow,
  getActiveWorkflowForThread,
} from "@terragon/shared/delivery-loop/store/workflow-store";

// ---------------------------------------------------------------------------
// V1 → V2 state mapping
// ---------------------------------------------------------------------------

/**
 * Maps old v1 SdlcLoopState to new v2 WorkflowState.kind
 */
export function mapV1StateToV2Kind(v1State: SdlcLoopState): WorkflowState {
  switch (v1State) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "review_gate":
      return "gating";
    case "ci_gate":
      return "gating";
    case "ui_gate":
      return "gating";
    case "awaiting_pr_link":
      return "awaiting_pr";
    case "babysitting":
      return "babysitting";
    case "blocked":
      return "awaiting_manual_fix";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "terminated_pr_closed":
      return "terminated";
    case "terminated_pr_merged":
      return "terminated";
    default:
      return "implementing";
  }
}

/**
 * Map v1 gate states to the correct GateKind for v2 stateJson.
 */
function resolveGateKindFromV1State(
  v1State: SdlcLoopState,
): "review" | "ci" | "ui" | null {
  switch (v1State) {
    case "review_gate":
      return "review";
    case "ci_gate":
      return "ci";
    case "ui_gate":
      return "ui";
    default:
      return null;
  }
}

/**
 * Build the initial stateJson for a v2 workflow based on the v1 state.
 */
export function buildInitialStateJson(
  v1State: SdlcLoopState,
  v1BlockedFromState?: SdlcLoopState | null,
  headSha?: string | null,
): Record<string, unknown> {
  const v2Kind = mapV1StateToV2Kind(v1State);

  switch (v2Kind) {
    case "planning":
      return { planVersion: null };
    case "implementing":
      return {
        planVersion: 1,
        dispatch: {
          kind: "queued",
          dispatchId: "d-migrated-0",
          executionClass: "implementation_runtime",
        },
      };
    case "gating": {
      const gate = resolveGateKindFromV1State(v1State) ?? "review";
      return {
        headSha: headSha ?? "unknown",
        gate: {
          kind: gate,
          status: "waiting",
          runId: null,
          snapshot:
            gate === "review"
              ? { requiredApprovals: 0, approvalsReceived: 0, blockers: [] }
              : gate === "ci"
                ? { checkSuites: [], failingRequiredChecks: [] }
                : { artifactUrl: null, blockers: [] },
        },
      };
    }
    case "awaiting_pr":
      return { headSha: headSha ?? "unknown" };
    case "babysitting":
      return {
        headSha: headSha ?? "unknown",
        reviewSurface: { kind: "github_pr", prNumber: 0 },
        nextCheckAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    case "awaiting_manual_fix": {
      const resumableKind = mapV1StateToResumableKind(v1BlockedFromState);
      const resumableBase = (() => {
        switch (resumableKind) {
          case "planning":
            return { kind: "planning" as const, planVersion: null };
          case "implementing":
            return {
              kind: "implementing" as const,
              dispatchId: "d-migrated-blocked-0",
            };
          case "gating": {
            const gate =
              resolveGateKindFromV1State(v1BlockedFromState!) ?? "review";
            return {
              kind: "gating" as const,
              gate,
              headSha: headSha ?? "unknown",
            };
          }
          case "awaiting_pr":
            return {
              kind: "awaiting_pr" as const,
              headSha: headSha ?? "unknown",
            };
          case "babysitting":
            return {
              kind: "babysitting" as const,
              headSha: headSha ?? "unknown",
            };
          default:
            return {
              kind: "implementing" as const,
              dispatchId: "d-migrated-blocked-0",
            };
        }
      })();
      return {
        reason: {
          description: "Migrated from v1 blocked state",
          suggestedAction: null,
        },
        resumableFrom: resumableBase,
      };
    }
    case "awaiting_plan_approval":
      return {
        planVersion: 1,
        resumableFrom: { kind: "planning", planVersion: null },
      };
    case "done":
      return { outcome: "completed", completedAt: new Date().toISOString() };
    case "stopped":
      return { reason: { kind: "user_requested" } };
    case "terminated":
      return {
        reason: {
          kind: v1State === "terminated_pr_merged" ? "pr_merged" : "pr_closed",
        },
      };
    default:
      return {};
  }
}

function mapV1StateToResumableKind(
  v1BlockedFromState?: SdlcLoopState | null,
): string {
  switch (v1BlockedFromState) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
      return "gating";
    case "awaiting_pr_link":
      return "awaiting_pr";
    case "babysitting":
      return "babysitting";
    default:
      return "implementing";
  }
}

// ---------------------------------------------------------------------------
// Enrollment bridge (idempotent)
// ---------------------------------------------------------------------------

export async function ensureV2WorkflowExists(params: {
  db: DB;
  threadId: string;
  sdlcLoopId: string;
  sdlcLoopState: SdlcLoopState;
  sdlcBlockedFromState?: SdlcLoopState | null;
  headSha?: string | null;
}): Promise<{ workflowId: string; created: boolean }> {
  // Check if v2 workflow already exists for this thread
  const existing = await getActiveWorkflowForThread({
    db: params.db,
    threadId: params.threadId,
  });
  if (existing) {
    return { workflowId: existing.id, created: false };
  }

  // Create v2 workflow mirroring the current v1 state
  const v2Kind = mapV1StateToV2Kind(params.sdlcLoopState);
  const stateJson = buildInitialStateJson(
    params.sdlcLoopState,
    params.sdlcBlockedFromState,
    params.headSha,
  );

  // Compute next generation to avoid unique constraint violation on (threadId, generation)
  const latest = await params.db.query.deliveryWorkflow.findFirst({
    where: eq(schema.deliveryWorkflow.threadId, params.threadId),
    orderBy: [desc(schema.deliveryWorkflow.generation)],
    columns: { generation: true },
  });
  const nextGeneration = (latest?.generation ?? 0) + 1;

  try {
    const workflow = await createWorkflow({
      db: params.db,
      threadId: params.threadId,
      generation: nextGeneration,
      kind: v2Kind,
      stateJson,
    });
    return { workflowId: workflow.id, created: true };
  } catch (err) {
    // Race: a concurrent caller may have inserted between our check and insert.
    // Re-query — if a workflow now exists, return it; otherwise rethrow.
    const raceWinner = await getActiveWorkflowForThread({
      db: params.db,
      threadId: params.threadId,
    });
    if (raceWinner) {
      return { workflowId: raceWinner.id, created: false };
    }
    throw err;
  }
}
