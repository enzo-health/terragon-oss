import { randomUUID } from "node:crypto";
import type { DeliveryLoopFailureCategory } from "@terragon/shared/model/delivery-loop";
import type {
  DeliveryLoopDaemonEvent,
  DeliveryLoopDispatchInput,
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
  return "unknown";
}

function buildRunUpdate(
  runId: string,
  overrides: Partial<NormalizedRunUpdate>,
): NormalizedRunUpdate {
  return {
    runId,
    runStatus: "pending",
    dispatchStatus: "prepared",
    firstEventAt: null,
    completedAt: null,
    terminalErrorCategory: null,
    terminalErrorMessage: null,
    usedSubAgents: false,
    subAgentFailureCount: 0,
    sessionId: null,
    headShaAtCompletion: null,
    diagnostics: {},
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
 * provides the prepare/dispatch/classify contract without duplicating that
 * logic.
 */
export class ClaudeCodeImplementationAdapter
  implements ImplementationRuntimeAdapter
{
  readonly agent = "claudeCode" as const;

  /** Tracks which runIds have received their first daemon event. */
  private acknowledgedRuns = new Set<string>();

  async prepare(input: DeliveryLoopDispatchInput): Promise<PreparedRun> {
    const runId = randomUUID();
    const dispatchIntentId = `di_${input.loopId}_${runId}`;
    return {
      runId,
      agent: this.agent,
      executionClass: "implementation_runtime",
      dispatchIntentId,
      sessionId: null,
    };
  }

  async dispatch(_prepared: PreparedRun): Promise<void> {
    // Dispatch is handled by the caller via sendDaemonMessage.
    // The caller tags the daemon message with prepared.runId and calls
    // sendDaemonMessage from apps/www/src/agent/daemon.ts.
    // Dispatch intent persistence will be added in Task #7.
  }

  async onDaemonEvent(
    event: DeliveryLoopDaemonEvent,
  ): Promise<NormalizedRunUpdate> {
    const { runId } = event;

    // First event for this runId transitions to "acknowledged".
    if (!this.acknowledgedRuns.has(runId)) {
      this.acknowledgedRuns.add(runId);
      return buildRunUpdate(runId, {
        runStatus: "running",
        dispatchStatus: "acknowledged",
        firstEventAt: event.timestamp,
        sessionId: event.sessionId,
      });
    }

    if (event.type === "terminal") {
      return this.classifyTerminal(event);
    }

    // Progress events.
    return buildRunUpdate(runId, {
      runStatus: "running",
      dispatchStatus: "acknowledged",
      sessionId: event.sessionId,
      headShaAtCompletion: event.headSha,
    });
  }

  classifyTerminal(event: DeliveryLoopDaemonEvent): NormalizedRunUpdate {
    const { runId } = event;

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
      event.errorMessage,
      event.exitCode,
    );
    return buildRunUpdate(runId, {
      runStatus: "failed",
      dispatchStatus: "failed",
      completedAt: event.timestamp,
      terminalErrorCategory: category,
      terminalErrorMessage: event.errorMessage,
      sessionId: event.sessionId,
      headShaAtCompletion: event.headSha,
      diagnostics: {
        exitCode: event.exitCode,
        failureCategory: category,
      },
    });
  }
}
