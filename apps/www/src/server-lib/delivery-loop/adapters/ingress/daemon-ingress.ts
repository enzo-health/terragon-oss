import type { DB } from "@terragon/shared/db";
import type { SdlcLoopCauseType } from "@terragon/shared/db/types";
import type {
  DeliverySignal,
  DaemonCompletionResult,
  DaemonFailure,
  DaemonProgress,
} from "@terragon/shared/delivery-loop/domain/signals";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { runCoordinatorTick } from "../../coordinator/tick";

// Raw daemon event payload (what the daemon HTTP endpoint receives)
export type DaemonEventPayload = {
  threadId: string;
  loopId: string;
  runId: string;
  status: "completed" | "failed" | "progress" | "stopped";
  headSha?: string | null;
  summary?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  remainingTasks?: number;
  completedTasks?: number;
  totalTasks?: number;
  currentTask?: string | null;
};

export type DaemonEventResponse = {
  selfDispatch: Record<string, unknown> | null;
};

const MAX_CONSECUTIVE_SELF_DISPATCHES = 7;

export function normalizeDaemonEvent(raw: DaemonEventPayload): DeliverySignal {
  switch (raw.status) {
    case "completed": {
      const result: DaemonCompletionResult =
        raw.remainingTasks != null && raw.remainingTasks > 0
          ? {
              kind: "partial",
              headSha: raw.headSha ?? "",
              summary: raw.summary ?? "",
              remainingTasks: raw.remainingTasks,
            }
          : {
              kind: "success",
              headSha: raw.headSha ?? "",
              summary: raw.summary ?? "",
            };
      return {
        source: "daemon",
        event: { kind: "run_completed", runId: raw.runId, result },
      };
    }

    case "failed":
    case "stopped": {
      const failure: DaemonFailure =
        raw.exitCode != null
          ? {
              kind: "runtime_crash",
              exitCode: raw.exitCode,
              message: raw.errorMessage ?? "Unknown error",
            }
          : {
              kind: "runtime_crash",
              exitCode: null,
              message: raw.errorMessage ?? "Unknown error",
            };
      return {
        source: "daemon",
        event: { kind: "run_failed", runId: raw.runId, failure },
      };
    }

    case "progress": {
      const progress: DaemonProgress = {
        completedTasks: raw.completedTasks ?? 0,
        totalTasks: raw.totalTasks ?? 0,
        currentTask: raw.currentTask ?? null,
      };
      return {
        source: "daemon",
        event: {
          kind: "progress_reported",
          runId: raw.runId,
          progress,
        },
      };
    }
  }
}

/**
 * Self-dispatch eligibility check. Only completed runs may trigger
 * an inline coordinator micro-tick that returns the next dispatch
 * payload in the HTTP response body.
 */
function isEligibleForSelfDispatch(signal: DeliverySignal): boolean {
  return signal.source === "daemon" && signal.event.kind === "run_completed";
}

/**
 * Handle an inbound daemon event: normalize to a typed signal,
 * append it to the signal inbox, and optionally run a synchronous
 * coordinator micro-tick for self-dispatch.
 */
export async function handleDaemonIngress(params: {
  db: DB;
  rawEvent: DaemonEventPayload;
  consecutiveDispatches?: number;
}): Promise<DaemonEventResponse> {
  const signal = normalizeDaemonEvent(params.rawEvent);
  const workflowId = params.rawEvent.loopId as WorkflowId;
  const consecutiveDispatches = params.consecutiveDispatches ?? 0;

  // Append signal to inbox via v2 store
  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );

  // The signal-inbox-store re-exports from signal-inbox-core which uses
  // the existing sdlcLoopSignalInbox table. For v2, we serialize the
  // DeliverySignal directly into the payload column.
  const causeType = mapSignalToCauseType(signal);

  await appendSignalToInbox({
    db: params.db,
    loopId: workflowId,
    causeType,
    payload: signal as Record<string, unknown>,
    canonicalCauseId: `daemon:${params.rawEvent.runId}:${params.rawEvent.status}`,
  });

  // Self-dispatch path: if the daemon completed and we haven't hit the
  // circuit breaker, run a synchronous coordinator micro-tick so the
  // next dispatch payload can be returned in this HTTP response.
  if (
    isEligibleForSelfDispatch(signal) &&
    consecutiveDispatches < MAX_CONSECUTIVE_SELF_DISPATCHES
  ) {
    try {
      const tickResult = await runCoordinatorTick({
        db: params.db,
        workflowId,
        correlationId:
          `self-dispatch:${params.rawEvent.runId}` as import("@terragon/shared/delivery-loop/domain/workflow").CorrelationId,
      });

      if (tickResult.transitioned && tickResult.workItemsScheduled > 0) {
        return {
          selfDispatch: {
            workflowId,
            correlationId: tickResult.correlationId,
          },
        };
      }
    } catch (err) {
      // Self-dispatch is best-effort; the async coordinator will pick it up
      console.warn("[daemon-ingress] self-dispatch micro-tick failed", {
        workflowId,
        runId: params.rawEvent.runId,
        error: err,
      });
    }
  }

  return { selfDispatch: null };
}

function mapSignalToCauseType(signal: DeliverySignal): SdlcLoopCauseType {
  if (signal.source !== "daemon") return "daemon_run_completed";
  switch (signal.event.kind) {
    case "run_completed":
      return "daemon_run_completed";
    case "run_failed":
      return "daemon_run_failed";
    case "progress_reported":
      return "daemon_progress";
  }
}
