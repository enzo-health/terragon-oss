import type { WorkflowId, DispatchId } from "./workflow";
import type { PublicationTarget } from "./events";
import type { DaemonFailure } from "./signals";

export type WorkItemStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "dead_lettered";

export type SelectedAgent = "codex" | "claude_code";
export type TransportMode = "self_dispatch" | "queue_fallback";

export type RetryRequest =
  | { kind: "dispatch_ack_timeout"; dispatchId: DispatchId }
  | { kind: "transient_daemon_failure"; failure: DaemonFailure }
  | { kind: "transient_publication_failure"; target: PublicationTarget }
  | { kind: "transient_github_failure"; operation: string }
  | { kind: "babysit_recheck_due"; dueAt: Date };

export type DeliveryWorkItem =
  | {
      kind: "dispatch";
      workItemId: string;
      workflowId: WorkflowId;
      dispatchId: DispatchId;
      agent: SelectedAgent;
      transport: TransportMode;
      status: WorkItemStatus;
      scheduledAt: Date;
      attempt: number;
    }
  | {
      kind: "publication";
      workItemId: string;
      workflowId: WorkflowId;
      target: PublicationTarget;
      status: WorkItemStatus;
      scheduledAt: Date;
      attempt: number;
    }
  | {
      kind: "retry";
      workItemId: string;
      workflowId: WorkflowId;
      retry: RetryRequest;
      status: WorkItemStatus;
      scheduledAt: Date;
      attempt: number;
    }
  | {
      kind: "babysit";
      workItemId: string;
      workflowId: WorkflowId;
      dueAt: Date;
      status: WorkItemStatus;
      attempt: number;
    };
