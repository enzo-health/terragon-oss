import { randomUUID } from "node:crypto";
import type { DB } from "@terragon/shared/db";
import type { DeliveryLoopFailureCategory } from "@terragon/shared/model/delivery-loop";
import {
  createDispatchIntent,
  markDispatchIntentDispatched,
  markDispatchIntentAcknowledged,
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
} from "@terragon/shared/model/delivery-loop";
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

  async prepare(
    input: DeliveryLoopDispatchInput,
    db: DB,
  ): Promise<PreparedRun> {
    const runId = randomUUID();
    const dispatchIntentId = await createDispatchIntent(db, {
      loopId: input.loopId,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      runId,
      targetPhase: input.targetPhase,
      selectedAgent: this.agent,
      executionClass: "implementation_runtime",
      dispatchMechanism: input.dispatchMechanism,
    });
    return {
      runId,
      agent: this.agent,
      executionClass: "implementation_runtime",
      dispatchIntentId,
      sessionId: null,
    };
  }

  async dispatch(prepared: PreparedRun, db: DB): Promise<void> {
    // Mark the intent as dispatched — daemon message is being sent by the
    // caller via sendDaemonMessage.
    await markDispatchIntentDispatched(db, prepared.runId);
  }

  async onDaemonEvent(
    event: DeliveryLoopDaemonEvent,
    db: DB,
  ): Promise<NormalizedRunUpdate> {
    const { runId } = event;

    // First event for this runId transitions to "acknowledged".
    if (!this.acknowledgedRuns.has(runId)) {
      this.acknowledgedRuns.add(runId);
      await markDispatchIntentAcknowledged(db, runId);
      return buildRunUpdate(runId, {
        runStatus: "running",
        dispatchStatus: "acknowledged",
        firstEventAt: event.timestamp,
        sessionId: event.sessionId,
      });
    }

    if (event.type === "terminal") {
      const update = this.classifyTerminal(event);
      if (update.runStatus === "completed") {
        await markDispatchIntentCompleted(db, runId);
      } else if (update.runStatus === "failed") {
        await markDispatchIntentFailed(
          db,
          runId,
          update.terminalErrorCategory,
          update.terminalErrorMessage,
        );
      }
      return update;
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
