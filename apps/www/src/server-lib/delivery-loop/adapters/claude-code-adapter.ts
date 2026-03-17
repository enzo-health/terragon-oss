import { randomUUID } from "node:crypto";
import type { DB } from "@terragon/shared/db";
import type { DeliveryLoopFailureCategory } from "@terragon/shared/delivery-loop/domain/failure";
import {
  createDispatchIntent,
  markDispatchIntentDispatched,
  markDispatchIntentAcknowledged,
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
} from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import type {
  DeliveryLoopDaemonEvent,
  DeliveryLoopDispatchInput,
  ImplementationRuntimeAdapter,
  NormalizedRunUpdate,
  PreparedRun,
} from "./types";
import { buildRunUpdate, classifyDaemonError } from "./shared";

/**
 * Maps raw error messages from Claude Code daemon events into
 * DeliveryLoopFailureCategory values. Tries Claude-specific patterns
 * first, then falls through to shared daemon-level patterns.
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

  // Context window overflow — non-retryable with the same input.
  if (
    /context.window|ran out of room|context.*too long|token limit|max.*tokens.*exceeded/i.test(
      rawErrorMessage,
    )
  ) {
    return "config_error";
  }

  // Overloaded / capacity — transient, retry.
  if (
    /overloaded|server busy|capacity exceeded|service unavailable|503/i.test(
      rawErrorMessage,
    )
  ) {
    return "claude_runtime_exit";
  }

  // Claude-specific patterns.
  if (/claude.*dispatch|dispatch.*fail/i.test(rawErrorMessage)) {
    return "claude_dispatch_failed";
  }
  if (/claude.*exit|claude.*crash|claude.*runtime/i.test(rawErrorMessage)) {
    return "claude_runtime_exit";
  }

  // Shared daemon-level patterns (rate limits, auth, network, disk, timeouts).
  return classifyDaemonError(rawErrorMessage, exitCode) ?? "unknown";
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
    // markDispatchIntentAcknowledged is idempotent (WHERE status = 'dispatched'),
    // so concurrent serverless invocations are safe.
    const isFirstEvent = await markDispatchIntentAcknowledged(db, runId);
    if (isFirstEvent) {
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
