/**
 * Dispatch-related types for the Delivery Loop v2 domain.
 *
 * These are the v2 canonical definitions for types that previously lived only
 * in the v1 model layer (`packages/shared/src/model/delivery-loop/`).
 *
 * Naming cross-reference:
 *   v1 `DeliveryLoopExecutionClass`   → v2 `ExecutionClass`   (workflow.ts)
 *   v1 `DeliveryLoopDispatchMechanism` → v2 `DispatchMechanism` (workflow.ts)
 *   The three types below have no equivalent in workflow.ts yet and are
 *   introduced here.
 */

import type { AIAgent } from "@terragon/agent/types";
import type { DeliveryLoopFailureCategory } from "./failure";
import type { ExecutionClass, DispatchMechanism } from "./workflow";

/**
 * The subset of workflow states that can receive a dispatched agent run.
 * Maps directly to the v1 `DeliveryLoopDispatchablePhase`.
 */
export type DispatchablePhase =
  | "implementing"
  | "review_gate"
  | "ci_gate"
  | "ui_gate";

/**
 * The agent that was selected (or will be selected) for a given dispatch.
 * Maps directly to the v1 `DeliveryLoopSelectedAgent`.
 */
export type SelectedAgent = "codex" | "claudeCode";

export function toSelectedAgent(agent: AIAgent): SelectedAgent {
  if (agent === "codex") return "codex";
  return "claudeCode";
}

/**
 * Lifecycle status of a single dispatch intent record.
 * Maps directly to the v1 `DeliveryLoopDispatchStatus`.
 */
export type DispatchIntentStatus =
  | "prepared"
  | "dispatched"
  | "acknowledged"
  | "failed"
  | "completed";

/**
 * A durable record of a dispatch intent. Persisted before any dispatch attempt
 * so that failed dispatches are recoverable.
 *
 * Maps directly to the v1 `DeliveryLoopDispatchIntent`; field names are
 * unchanged so existing callers can adopt this type without rename churn.
 */
export type DispatchIntent = {
  id: string;
  loopId: string;
  threadId: string;
  threadChatId: string;
  targetPhase: DispatchablePhase;
  selectedAgent: SelectedAgent;
  executionClass: ExecutionClass;
  dispatchMechanism: DispatchMechanism;
  runId: string;
  status: DispatchIntentStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
  lastFailureCategory: DeliveryLoopFailureCategory | null;
  gate?: string;
  headSha?: string;
};
