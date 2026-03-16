import type { DB } from "@terragon/shared/db";
import type { SdlcLoopCauseType } from "@terragon/shared/db/types";
import type {
  WorkflowId,
  GateKind,
} from "@terragon/shared/delivery-loop/domain/workflow";
import type { DeliverySignal } from "@terragon/shared/delivery-loop/domain/signals";

export type HumanAction = "resume" | "bypass" | "stop" | "mark_done";

/**
 * Normalize a human action to a typed DeliverySignal.
 */
export function normalizeHumanAction(params: {
  action: HumanAction;
  actorUserId: string;
  gate?: GateKind;
}): DeliverySignal {
  switch (params.action) {
    case "resume":
      return {
        source: "human",
        event: {
          kind: "resume_requested",
          actorUserId: params.actorUserId,
        },
      };
    case "bypass":
      return {
        source: "human",
        event: {
          kind: "bypass_requested",
          actorUserId: params.actorUserId,
          target: params.gate ?? "ci",
        },
      };
    case "stop":
      return {
        source: "human",
        event: {
          kind: "stop_requested",
          actorUserId: params.actorUserId,
        },
      };
    case "mark_done":
      return {
        source: "human",
        event: {
          kind: "mark_done_requested",
          actorUserId: params.actorUserId,
        },
      };
  }
}

/**
 * Handle a human action: normalize to a typed signal, append it
 * to the workflow's signal inbox, and wake the coordinator.
 */
export async function handleHumanAction(params: {
  db: DB;
  action: HumanAction;
  actorUserId: string;
  workflowId: WorkflowId;
  /** V1 sdlcLoop ID used as inbox partition key. Must match the key cron uses to drain. */
  inboxPartitionKey: string;
  gate?: GateKind;
  wakeCoordinator?: (workflowId: WorkflowId) => Promise<void>;
}): Promise<void> {
  const signal = normalizeHumanAction({
    action: params.action,
    actorUserId: params.actorUserId,
    gate: params.gate,
  });

  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );

  const causeType = mapHumanSignalToCauseType(signal);
  await appendSignalToInbox({
    db: params.db,
    loopId: params.inboxPartitionKey,
    causeType,
    payload: signal as Record<string, unknown>,
    canonicalCauseId: `human:${params.workflowId}:${params.action}:${Date.now()}`,
  });

  if (params.wakeCoordinator) {
    params.wakeCoordinator(params.workflowId).catch((err) => {
      console.warn("[human-interventions] wakeCoordinator failed", {
        workflowId: params.workflowId,
        error: err,
      });
    });
  }
}

function mapHumanSignalToCauseType(signal: DeliverySignal): SdlcLoopCauseType {
  if (signal.source !== "human") return "human_resume";
  switch (signal.event.kind) {
    case "resume_requested":
      return "human_resume";
    case "bypass_requested":
      return "human_bypass";
    case "stop_requested":
      return "human_stop";
    case "mark_done_requested":
      return "human_mark_done";
  }
}
