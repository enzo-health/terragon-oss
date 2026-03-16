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

    case "failed": {
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

    case "stopped": {
      // User-initiated stop — map to human signal so the coordinator
      // transitions to "stopped" instead of retrying implementation.
      return {
        source: "human",
        event: { kind: "stop_requested", actorUserId: "daemon" },
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
  /** The v2 workflow ID — distinct from rawEvent.loopId (v1 sdlcLoop ID). */
  workflowId: WorkflowId;
  consecutiveDispatches?: number;
}): Promise<DaemonEventResponse> {
  const signal = normalizeDaemonEvent(params.rawEvent);
  const { workflowId } = params;
  // The signal inbox is keyed by v1 loopId for backwards compatibility
  // with the shared sdlcLoopSignalInbox table.
  const inboxPartitionKey = params.rawEvent.loopId;
  const consecutiveDispatches = params.consecutiveDispatches ?? 0;

  // Append signal to inbox via v2 store
  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );

  const causeType = mapSignalToCauseType(signal);

  await appendSignalToInbox({
    db: params.db,
    loopId: inboxPartitionKey,
    causeType,
    payload: signal as Record<string, unknown>,
    // Progress events include a timestamp so later updates aren't deduplicated
    // against earlier ones. Terminal/completed events use just runId:status
    // for proper idempotency on daemon retries.
    canonicalCauseId:
      params.rawEvent.status === "progress"
        ? `daemon:${params.rawEvent.runId}:progress:${Date.now()}`
        : `daemon:${params.rawEvent.runId}:${params.rawEvent.status}`,
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
        loopId: inboxPartitionKey,
      });

      if (tickResult.transitioned && tickResult.workItemsScheduled > 0) {
        // TODO: construct a real SdlcSelfDispatchPayload from the
        // prepared dispatch/replay state. For now, return null — the
        // cron/work-queue path handles dispatch instead.
        return { selfDispatch: null };
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
  switch (signal.source) {
    case "daemon":
      switch (signal.event.kind) {
        case "run_completed":
          return "daemon_run_completed";
        case "run_failed":
          return "daemon_run_failed";
        case "progress_reported":
          return "daemon_progress";
      }
      break;
    case "human":
      // Daemon-reported stop maps to human source; route via human_resume
      // so the v2-shaped payload bypasses causeType mapping in tick.ts.
      return "human_resume";
    case "github":
    case "timer":
    case "babysit":
      return "daemon_run_completed";
  }
  return "daemon_run_completed";
}
