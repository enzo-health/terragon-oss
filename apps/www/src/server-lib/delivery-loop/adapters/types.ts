import type { DB } from "@terragon/shared/db";
import type {
  DeliveryLoopDispatchablePhase,
  DeliveryLoopDispatchStatus,
  DeliveryLoopSelectedAgent,
} from "@terragon/shared/model/delivery-loop";
import type { DeliveryLoopFailureCategory } from "@terragon/shared/delivery-loop/domain/failure";

/**
 * A fully prepared run ready for dispatch. Created by
 * `ImplementationRuntimeAdapter.prepare()`.
 */
export type PreparedRun = {
  runId: string;
  agent: DeliveryLoopSelectedAgent;
  executionClass: "implementation_runtime";
  dispatchIntentId: string;
  sessionId: string | null;
};

/**
 * Status of an active or completed run, as reported by daemon events.
 */
export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

/**
 * A normalized view of a run update, produced by
 * `ImplementationRuntimeAdapter.onDaemonEvent()` or
 * `classifyTerminal()`. This is the adapter's output contract —
 * the Delivery Loop state machine consumes this to decide transitions.
 */
export type NormalizedRunUpdate = {
  runId: string;
  runStatus: RunStatus;
  dispatchStatus: DeliveryLoopDispatchStatus;
  firstEventAt: Date | null;
  completedAt: Date | null;
  terminalErrorCategory: DeliveryLoopFailureCategory | null;
  terminalErrorMessage: string | null;
  usedSubAgents: boolean;
  subAgentFailureCount: number;
  sessionId: string | null;
  headShaAtCompletion: string | null;
  diagnostics: Record<string, unknown>;
};

/**
 * Input required to prepare and dispatch an implementation run.
 */
export type DeliveryLoopDispatchInput = {
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
  loopId: string;
  prompt: string;
  model: string;
  targetPhase: DeliveryLoopDispatchablePhase;
  dispatchMechanism: "self_dispatch" | "queue_fallback";
};

/**
 * Daemon event as received by the adapter. This is a subset of the
 * full daemon event payload, normalized for adapter consumption.
 */
export type DeliveryLoopDaemonEvent = {
  runId: string;
  type: "first_event" | "progress" | "terminal";
  isError: boolean;
  errorMessage: string | null;
  sessionId: string | null;
  headSha: string | null;
  exitCode: number | null;
  timestamp: Date;
};

/**
 * The contract that every agent runtime (Claude Code, Codex, etc.)
 * must implement so the Delivery Loop can dispatch and monitor runs
 * in a uniform way.
 */
export interface ImplementationRuntimeAdapter {
  readonly agent: DeliveryLoopSelectedAgent;

  /**
   * Resume the sandbox, ensure the daemon is healthy, create a runId,
   * persist a dispatch intent, and create credentials.
   * Returns a PreparedRun ready for `dispatch()`.
   */
  prepare(input: DeliveryLoopDispatchInput, db: DB): Promise<PreparedRun>;

  /**
   * Send the daemon message tagged with the runId from `prepare()`.
   * Persists dispatchStatus = "dispatched".
   */
  dispatch(prepared: PreparedRun, db: DB): Promise<void>;

  /**
   * Process an inbound daemon event for the given runId.
   * First event for a runId transitions dispatchStatus to "acknowledged".
   * Returns a NormalizedRunUpdate reflecting the current run state.
   */
  onDaemonEvent(
    event: DeliveryLoopDaemonEvent,
    db: DB,
  ): Promise<NormalizedRunUpdate>;

  /**
   * Classify a terminal daemon event (error or completion) into a
   * NormalizedRunUpdate with agent-specific failure categories.
   */
  classifyTerminal(event: DeliveryLoopDaemonEvent): NormalizedRunUpdate;
}
