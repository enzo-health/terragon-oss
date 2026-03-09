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
import { buildRunUpdate, classifyDaemonError } from "./shared";

/**
 * Maps raw error messages from Codex daemon events into
 * DeliveryLoopFailureCategory values. Tries Codex-specific patterns
 * first, then falls through to shared daemon-level patterns.
 */
function classifyCodexTerminalError(
  rawErrorMessage: string | null,
  exitCode: number | null,
): DeliveryLoopFailureCategory {
  if (!rawErrorMessage) {
    return exitCode !== 0 && exitCode !== null
      ? "codex_app_server_exit"
      : "unknown";
  }

  // Codex app-server process exited or crashed.
  if (/codex.*app.?server.*exit|app.?server.*crash/i.test(rawErrorMessage)) {
    return "codex_app_server_exit";
  }

  // Sub-agent (collab_tool_call) failure.
  if (/codex.*subagent|subagent.*fail/i.test(rawErrorMessage)) {
    return "codex_subagent_failed";
  }

  // Codex turn-level failure (API error, rate limit, etc.).
  if (/codex.*turn.*fail|codex.*error/i.test(rawErrorMessage)) {
    return "codex_turn_failed";
  }

  // Shared daemon-level patterns.
  return classifyDaemonError(rawErrorMessage, exitCode) ?? "unknown";
}

/**
 * Checks if a daemon event error message indicates a sub-agent
 * (collab_tool_call) was used or failed.
 */
function detectSubAgentUsage(event: DeliveryLoopDaemonEvent): {
  usedSubAgents: boolean;
  subAgentFailureCount: number;
} {
  if (!event.errorMessage) {
    return { usedSubAgents: false, subAgentFailureCount: 0 };
  }
  const usedSubAgents = /subagent|collab_tool_call|delegated.*sub/i.test(
    event.errorMessage,
  );
  const subAgentFailureCount =
    usedSubAgents && /fail|error|crash/i.test(event.errorMessage) ? 1 : 0;
  return { usedSubAgents, subAgentFailureCount };
}

/**
 * ImplementationRuntimeAdapter for Codex agent.
 *
 * Codex uses the codex-app-server transport mode (JSON-RPC over
 * stdin/stdout) rather than Claude Code's legacy shell spawn. The
 * adapter follows the same prepare/dispatch/onDaemonEvent/classifyTerminal
 * contract but uses Codex-specific error classification.
 *
 * Key differences from ClaudeCodeImplementationAdapter:
 * - Transport mode is "codex-app-server" (not "legacy")
 * - Sub-agent tracking via collab_tool_call events
 * - Error patterns match Codex app-server and turn failures
 * - ACP is excluded from the Delivery Loop happy path
 */
export class CodexImplementationAdapter
  implements ImplementationRuntimeAdapter
{
  readonly agent = "codex" as const;

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
    // caller via the codex-app-server transport mode.
    await markDispatchIntentDispatched(db, prepared.runId);
  }

  async onDaemonEvent(
    event: DeliveryLoopDaemonEvent,
    db: DB,
  ): Promise<NormalizedRunUpdate> {
    const { runId } = event;
    const subAgentInfo = detectSubAgentUsage(event);

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
        ...subAgentInfo,
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
      ...subAgentInfo,
    });
  }

  classifyTerminal(event: DeliveryLoopDaemonEvent): NormalizedRunUpdate {
    const { runId } = event;
    const subAgentInfo = detectSubAgentUsage(event);

    if (!event.isError) {
      return buildRunUpdate(runId, {
        runStatus: "completed",
        dispatchStatus: "acknowledged",
        completedAt: event.timestamp,
        sessionId: event.sessionId,
        headShaAtCompletion: event.headSha,
        ...subAgentInfo,
      });
    }

    const category = classifyCodexTerminalError(
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
      ...subAgentInfo,
      diagnostics: {
        exitCode: event.exitCode,
        failureCategory: category,
        ...subAgentInfo,
      },
    });
  }
}
