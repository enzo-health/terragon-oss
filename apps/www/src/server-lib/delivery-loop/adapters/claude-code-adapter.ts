import { randomUUID } from "node:crypto";
import type { DeliveryLoopFailureCategory } from "@terragon/shared/model/delivery-loop";
import type {
  AdapterContext,
  DaemonEventInput,
  DaemonTerminalInput,
  ImplementationRuntimeAdapter,
  NormalizedRunUpdate,
  PreparedRun,
} from "./types";

/**
 * Maps raw error messages from Claude Code daemon events into
 * DeliveryLoopFailureCategory values.
 */
function classifyClaudeTerminalError(
  rawErrorMessage: string | null,
  exitCode: number | null,
): DeliveryLoopFailureCategory {
  if (!rawErrorMessage) {
    return exitCode !== 0 && exitCode !== null
      ? "claude_runtime_exit"
      : "unknown";
  }
  const msg = rawErrorMessage.toLowerCase();

  if (
    /unix socket|econnrefused|enoent.*socket|no such file|connect failed/i.test(
      rawErrorMessage,
    ) ||
    /daemon.*not running|daemon.*dead|ping.*fail/i.test(rawErrorMessage)
  ) {
    return "daemon_unreachable";
  }
  if (
    /spawn|fork|exec|eacces|enoent.*daemon|cannot find module/i.test(
      rawErrorMessage,
    )
  ) {
    return "daemon_spawn_failed";
  }
  if (
    /timeout|timed out|ack.*timeout|dispatch.*timeout/i.test(rawErrorMessage)
  ) {
    return "dispatch_ack_timeout";
  }
  if (/claude.*dispatch|dispatch.*fail/i.test(rawErrorMessage)) {
    return "claude_dispatch_failed";
  }
  if (/claude.*exit|claude.*crash|claude.*runtime/i.test(rawErrorMessage)) {
    return "claude_runtime_exit";
  }
  if (msg.includes("daemon") || msg.includes("write message")) {
    return "unknown";
  }
  return "unknown";
}

function buildRunUpdate(
  runId: string,
  overrides: Partial<NormalizedRunUpdate>,
): NormalizedRunUpdate {
  return {
    runId,
    runStatus: "preparing",
    dispatchStatus: null,
    firstEventAt: null,
    completedAt: null,
    terminalErrorCategory: null,
    terminalErrorMessage: null,
    usedSubAgents: [],
    subAgentFailureCount: 0,
    sessionId: null,
    headShaAtCompletion: null,
    diagnostics: null,
    ...overrides,
  };
}

/**
 * ImplementationRuntimeAdapter for Claude Code agent.
 *
 * This is a thin interface layer — it delegates to existing sandbox resume,
 * daemon health, and sendDaemonMessage infrastructure. The adapter exists
 * so the Delivery Loop state machine can dispatch and monitor Claude Code
 * runs through a uniform contract shared with Codex and future agents.
 *
 * Actual side effects (sandbox resume, credential creation, message sending)
 * are performed by the caller using the existing infrastructure. This adapter
 * provides the prepare/dispatch/classify contract without duplicating that logic.
 */
export class ClaudeCodeImplementationAdapter
  implements ImplementationRuntimeAdapter
{
  readonly agent = "claudeCode" as const;
  readonly executionClass = "daemon" as const;

  async prepare(_ctx: AdapterContext): Promise<PreparedRun> {
    const runId = randomUUID();
    return {
      runId,
      agent: this.agent,
      executionClass: this.executionClass,
      dispatchIntentId: null,
      sessionId: null,
    };
  }

  async dispatch(_ctx: AdapterContext, _run: PreparedRun): Promise<void> {
    // Dispatch is handled by the caller via sendDaemonMessage.
    // This method exists to satisfy the interface contract.
    // In the future, dispatch intent persistence and status tracking
    // will be implemented here (Task #7).
  }

  onDaemonEvent(
    _ctx: AdapterContext,
    runId: string,
    event: DaemonEventInput,
  ): NormalizedRunUpdate {
    if (event.type === "first_event") {
      return buildRunUpdate(runId, {
        runStatus: "acknowledged",
        dispatchStatus: "acknowledged",
        firstEventAt: event.timestamp,
        sessionId: event.sessionId,
      });
    }

    if (event.type === "terminal") {
      return this.classifyTerminal(_ctx, runId, {
        ...event,
        type: "terminal",
        exitCode: null,
        rawErrorMessage: event.errorMessage,
      });
    }

    // Progress events
    return buildRunUpdate(runId, {
      runStatus: "running",
      dispatchStatus: "acknowledged",
      sessionId: event.sessionId,
      headShaAtCompletion: event.headSha,
    });
  }

  classifyTerminal(
    _ctx: AdapterContext,
    runId: string,
    event: DaemonTerminalInput,
  ): NormalizedRunUpdate {
    if (!event.isError) {
      return buildRunUpdate(runId, {
        runStatus: "completed",
        dispatchStatus: "acknowledged",
        completedAt: event.timestamp,
        sessionId: event.sessionId,
        headShaAtCompletion: event.headSha,
      });
    }

    const category = classifyClaudeTerminalError(
      event.rawErrorMessage,
      event.exitCode,
    );
    return buildRunUpdate(runId, {
      runStatus: "failed",
      dispatchStatus: "failed",
      completedAt: event.timestamp,
      terminalErrorCategory: category,
      terminalErrorMessage: event.rawErrorMessage,
      sessionId: event.sessionId,
      headShaAtCompletion: event.headSha,
    });
  }
}
