/**
 * Signal inbox integration: bridge between the existing v1 signal-inbox
 * processing loop and the new v2 coordinator.
 *
 * After the existing `processSignalInboxForLoop` processes a signal,
 * this module optionally forwards the result to the v2 event log
 * for dual-write. During migration the v1 signal processing remains
 * authoritative; the v2 side is forensic-only.
 *
 * Eventually the v1 signal processing is removed and only the v2
 * coordinator runs.
 */
import type { DB } from "@terragon/shared/db";
import type { SdlcLoopState } from "@terragon/shared/db/types";
import type { CorrelationId } from "@terragon/shared/delivery-loop/domain/workflow";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { updateWorkflowState } from "@terragon/shared/delivery-loop/store/workflow-store";
import { appendWorkflowEvent } from "@terragon/shared/delivery-loop/store/event-store";
import { upsertRuntimeStatus } from "@terragon/shared/delivery-loop/store/runtime-status-store";

import { mapV1StateToV2Kind, buildInitialStateJson } from "./enrollment-bridge";
import { ensureV2WorkflowExists } from "./enrollment-bridge";

// ---------------------------------------------------------------------------
// V1 transition event → v2 event kind mapping
// ---------------------------------------------------------------------------

/**
 * Map a v1 SdlcLoopTransitionEvent to a v2 DeliveryWorkflowEvent kind.
 * Returns null if the event has no meaningful v2 equivalent.
 */
function mapV1TransitionEventToV2EventKind(
  transitionEvent: string,
): string | null {
  switch (transitionEvent) {
    case "plan_completed":
      return "plan_approved";
    case "implementation_completed":
      return "implementation_succeeded";
    case "review_passed":
    case "ci_gate_passed":
    case "review_threads_gate_passed":
    case "deep_review_gate_passed":
    case "carmack_review_gate_passed":
    case "ui_smoke_passed":
    case "video_capture_succeeded":
      return "gate_evaluated";
    case "review_blocked":
    case "ci_gate_blocked":
    case "review_threads_gate_blocked":
    case "deep_review_gate_blocked":
    case "carmack_review_gate_blocked":
    case "ui_smoke_failed":
    case "video_capture_failed":
      return "gate_evaluated";
    case "pr_linked":
      return "review_surface_attached";
    case "babysit_passed":
      return "workflow_completed";
    case "babysit_blocked":
      return "gate_evaluated";
    case "manual_stop":
      return "workflow_stopped";
    case "pr_closed_unmerged":
      return "workflow_terminated";
    case "pr_merged":
      return "workflow_terminated";
    case "mark_done":
      return "workflow_completed";
    case "blocked_resume_requested":
    case "blocked_bypass_once_requested":
      return "dispatch_enqueued";
    case "human_feedback_requested":
      return "manual_fix_required";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Forward the outcome of a v1 signal-inbox tick to the v2 event log.
 * This is a best-effort forensic write — failures are logged but do
 * not block v1 processing.
 */
export async function forwardSignalResultToV2(params: {
  db: DB;
  sdlcLoopId: string;
  threadId: string;
  signalId: string;
  transitionEvent: string;
  v1StateBefore: SdlcLoopState;
  v1StateAfter: SdlcLoopState;
  headSha: string | null;
  loopVersion: number;
}): Promise<void> {
  try {
    // 1. Look up or create the v2 workflow for this thread
    const { workflowId } = await ensureV2WorkflowExists({
      db: params.db,
      threadId: params.threadId,
      sdlcLoopId: params.sdlcLoopId,
      sdlcLoopState: params.v1StateAfter,
      headSha: params.headSha,
    });

    // 2. Map the v1 transition event to a v2 event kind
    const v2EventKind = mapV1TransitionEventToV2EventKind(
      params.transitionEvent,
    );
    if (!v2EventKind) {
      // No meaningful v2 equivalent — skip
      return;
    }

    // 3. Derive v2 states from v1 states
    const v2StateBefore = mapV1StateToV2Kind(params.v1StateBefore);
    const v2StateAfter = mapV1StateToV2Kind(params.v1StateAfter);

    // 4. Append to the v2 event log (forensic only during migration)
    const correlationId = `v1-forward-${params.signalId}` as CorrelationId;
    await appendWorkflowEvent({
      db: params.db,
      workflowId,
      correlationId,
      eventKind: v2EventKind,
      stateBefore: v2StateBefore,
      stateAfter: v2StateAfter,
      headSha: params.headSha,
      signalId: params.signalId,
      triggerSource: "v1_signal_inbox_forward",
    });

    // 5. Update v2 workflow state to match v1 outcome
    const workflow = await getActiveWorkflowForThread({
      db: params.db,
      threadId: params.threadId,
    });
    if (workflow && workflow.kind !== v2StateAfter) {
      const stateJson = buildInitialStateJson(
        params.v1StateAfter,
        null,
        params.headSha,
      );
      await updateWorkflowState({
        db: params.db,
        workflowId,
        expectedVersion: workflow.version,
        kind: v2StateAfter,
        stateJson,
        headSha: params.headSha,
      });
    }

    // 6. Update runtime status
    await upsertRuntimeStatus({
      db: params.db,
      workflowId,
      state: v2StateAfter,
      health: "healthy",
      lastSignalAt: new Date(),
      lastTransitionAt:
        params.v1StateBefore !== params.v1StateAfter ? new Date() : null,
    });
  } catch (error) {
    // Best-effort: log and continue
    console.error("[signal-inbox-integration] forwardSignalResultToV2 failed", {
      sdlcLoopId: params.sdlcLoopId,
      threadId: params.threadId,
      signalId: params.signalId,
      transitionEvent: params.transitionEvent,
      error,
    });
  }
}
