import type { AIAgent } from "@terragon/agent/types";
import type {
  DeliveryLoopDispatchStatus,
  DeliveryLoopFailureCategory,
} from "@terragon/shared/model/delivery-loop";

/**
 * Execution class determines how the agent run is executed.
 * - "daemon": spawned via daemon on a sandbox (Claude Code, Codex)
 * - "api": direct API call (future: Gemini, Amp)
 */
export type ExecutionClass = "daemon" | "api";

/**
 * A fully prepared run ready for dispatch. Created by
 * `ImplementationRuntimeAdapter.prepare()`.
 */
export type PreparedRun = {
  runId: string;
  agent: AIAgent;
  executionClass: ExecutionClass;
  dispatchIntentId: string | null;
  sessionId: string | null;
};

/**
 * Status of an active or completed run, as reported by daemon events.
 */
export type RunStatus =
  | "preparing"
  | "dispatched"
  | "acknowledged"
  | "running"
  | "completed"
  | "failed";

/**
 * A normalized view of a run update, produced by
 * `ImplementationRuntimeAdapter.onDaemonEvent()` or
 * `classifyTerminal()`. This is the adapter's output contract —
 * the Delivery Loop state machine consumes this to decide transitions.
 */
export type NormalizedRunUpdate = {
  runId: string;
  runStatus: RunStatus;
  dispatchStatus: DeliveryLoopDispatchStatus | null;
  firstEventAt: Date | null;
  completedAt: Date | null;
  terminalErrorCategory: DeliveryLoopFailureCategory | null;
  terminalErrorMessage: string | null;
  usedSubAgents: string[];
  subAgentFailureCount: number;
  sessionId: string | null;
  headShaAtCompletion: string | null;
  diagnostics: Record<string, unknown> | null;
};

/**
 * Context passed to adapter methods so they can interact with
 * the sandbox, thread, and loop without knowing the specifics.
 */
export type AdapterContext = {
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
  loopId: string;
};

/**
 * The contract that every agent runtime (Claude Code, Codex, etc.)
 * must implement so the Delivery Loop can dispatch and monitor runs
 * in a uniform way.
 */
export interface ImplementationRuntimeAdapter {
  readonly agent: AIAgent;
  readonly executionClass: ExecutionClass;

  /**
   * Resume the sandbox, ensure the daemon is healthy, create a runId,
   * persist a dispatch intent, and create credentials.
   * Returns a PreparedRun ready for `dispatch()`.
   */
  prepare(ctx: AdapterContext): Promise<PreparedRun>;

  /**
   * Send the daemon message tagged with the runId from `prepare()`.
   * Persists dispatchStatus = "dispatched".
   */
  dispatch(ctx: AdapterContext, run: PreparedRun): Promise<void>;

  /**
   * Process an inbound daemon event for the given runId.
   * First event for a runId transitions dispatchStatus to "acknowledged".
   * Returns a NormalizedRunUpdate reflecting the current run state.
   */
  onDaemonEvent(
    ctx: AdapterContext,
    runId: string,
    event: DaemonEventInput,
  ): NormalizedRunUpdate;

  /**
   * Classify a terminal daemon event (error or completion) into a
   * NormalizedRunUpdate with agent-specific failure categories.
   */
  classifyTerminal(
    ctx: AdapterContext,
    runId: string,
    event: DaemonTerminalInput,
  ): NormalizedRunUpdate;
}

/**
 * Minimal daemon event shape consumed by the adapter.
 * This is a subset of the full daemon event payload.
 */
export type DaemonEventInput = {
  type: "first_event" | "progress" | "terminal";
  isError: boolean;
  errorMessage: string | null;
  sessionId: string | null;
  headSha: string | null;
  timestamp: Date;
};

/**
 * Terminal event input with additional classification fields.
 */
export type DaemonTerminalInput = DaemonEventInput & {
  type: "terminal";
  exitCode: number | null;
  rawErrorMessage: string | null;
};
