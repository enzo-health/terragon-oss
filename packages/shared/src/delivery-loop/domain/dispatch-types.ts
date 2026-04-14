/**
 * Dispatch-related types for the Delivery Loop domain.
 *
 * Canonical definitions for dispatch intent types. Cross-references:
 *   `ExecutionClass`   (workflow.ts)
 *   `DispatchMechanism` (workflow.ts)
 */

import type { AIAgent } from "@terragon/agent/types";
import type { DeliveryLoopFailureCategory } from "./failure";
import type { ExecutionClass, DispatchMechanism } from "./workflow";

/**
 * The subset of workflow states that can receive a dispatched agent run.
 */
export type DispatchablePhase = "implementing" | "review_gate" | "ci_gate";

/**
 * The agent that was selected (or will be selected) for a given dispatch.
 */
export type SelectedAgent = "codex" | "claudeCode";

export function toSelectedAgent(agent: AIAgent): SelectedAgent {
  if (agent === "codex") return "codex";
  return "claudeCode";
}

/**
 * Lifecycle status of a single dispatch intent record.
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
