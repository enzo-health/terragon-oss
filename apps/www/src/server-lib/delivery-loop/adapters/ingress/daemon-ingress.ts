import type { DB } from "@terragon/shared/db";
import type { SdlcLoopCauseType } from "@terragon/shared/db/types";
import type {
  DeliverySignal,
  DaemonCompletionResult,
  DaemonFailure,
  DaemonProgress,
} from "@terragon/shared/delivery-loop/domain/signals";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import type { DaemonOutcome } from "@terragon/shared/delivery-loop/domain/outcomes";
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
  workItemsScheduled: number;
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
  /** Typed outcome preserving ingress envelope metadata. Optional for backward compatibility. */
  outcome?: DaemonOutcome;
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
    // against earlier ones. Terminal/completed events use runId:status:resultKind
    // for proper idempotency on daemon retries. The resultKind suffix is critical:
    // partial completions (remainingTasks > 0) and final success completions
    // share the same raw status "completed", but must produce distinct inbox rows
    // so the final success signal isn't dropped by ON CONFLICT DO NOTHING.
    // Progress events use a stable identity derived from the task snapshot
    // so network retries of the same progress update deduplicate, while
    // genuinely new progress updates (different task counts) still append.
    canonicalCauseId:
      params.rawEvent.status === "progress"
        ? `daemon:${params.rawEvent.runId}:progress:${params.rawEvent.completedTasks ?? 0}:${params.rawEvent.totalTasks ?? 0}:${params.rawEvent.currentTask ?? "none"}`
        : `daemon:${params.rawEvent.runId}:${params.rawEvent.status}:${
            params.rawEvent.status === "completed" &&
            params.rawEvent.remainingTasks != null &&
            params.rawEvent.remainingTasks > 0
              ? "partial"
              : "terminal"
          }`,
  });

  // Self-dispatch path: if the daemon completed, run a synchronous
  // coordinator micro-tick to consume the signal from the inbox.
  // When under the circuit breaker limit, the tick result could
  // carry a self-dispatch payload in the HTTP response (not yet wired).
  // When AT the limit, we still run the tick to consume the signal —
  // otherwise it accumulates in the inbox and cron processes it anyway,
  // defeating the breaker. The breaker's purpose is to prevent tight
  // HTTP-level self-dispatch loops; the work queue handles dispatch
  // asynchronously regardless.
  if (isEligibleForSelfDispatch(signal)) {
    const breakerTripped =
      consecutiveDispatches >= MAX_CONSECUTIVE_SELF_DISPATCHES;
    if (breakerTripped) {
      console.warn("[daemon-ingress] self-dispatch circuit breaker tripped", {
        workflowId,
        runId: params.rawEvent.runId,
        consecutiveDispatches,
      });
    }
    try {
      const tickResult = await runCoordinatorTick({
        db: params.db,
        workflowId,
        correlationId:
          `self-dispatch:${params.rawEvent.runId}` as import("@terragon/shared/delivery-loop/domain/workflow").CorrelationId,
        loopId: inboxPartitionKey,
      });

      if (
        !breakerTripped &&
        tickResult.transitioned &&
        tickResult.workItemsScheduled > 0
      ) {
        // TODO: construct a real SdlcSelfDispatchPayload from the
        // prepared dispatch/replay state. For now, return null — the
        // cron/work-queue path handles dispatch instead.
        return {
          selfDispatch: null,
          workItemsScheduled: tickResult.workItemsScheduled,
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

  return { selfDispatch: null, workItemsScheduled: 0 };
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
      if (signal.event.kind === "stop_requested") return "human_stop";
      return "human_resume";
    case "github":
    case "timer":
    case "babysit":
      return "daemon_run_completed";
  }
  return "daemon_run_completed";
}
