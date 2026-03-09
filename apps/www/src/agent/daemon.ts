import { auth } from "@/lib/auth";
import { DaemonMessage } from "@terragon/daemon/shared";
import { ThreadErrorType } from "@terragon/shared";
import { ISandboxSession } from "@terragon/sandbox/types";
import { sendMessage } from "@terragon/sandbox/daemon";
import { setActiveThreadChat } from "./sandbox-resource";
import { wrapError } from "./error";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { db } from "@/lib/db";
import { updateAgentRunContext } from "@terragon/shared/model/agent-run-context";
import { AIAgent } from "@terragon/agent/types";
import { createDaemonRunCredentials } from "@/agent/helpers/create-daemon-run";
import { DeliveryLoopFailureCategory } from "@terragon/shared/model/delivery-loop";

type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

type RunContext = {
  runId: string;
  tokenNonce: string;
  transportMode: "legacy" | "acp" | "codex-app-server";
  protocolVersion: 1 | 2;
  agent: AIAgent;
};

type SendDaemonMessageArgsBase = {
  threadId: string;
  userId: string;
  threadChatId: string;
  sandboxId: string;
  session: ISandboxSession;
};

type SendDaemonMessageArgs =
  | (SendDaemonMessageArgsBase & {
      message: DistributiveOmit<
        Extract<DaemonMessage, { type: "claude" }>,
        "token" | "threadId" | "threadChatId" | "featureFlags"
      >;
      runContext: RunContext;
    })
  | (SendDaemonMessageArgsBase & {
      message: DistributiveOmit<
        Extract<DaemonMessage, { type: "stop" }>,
        "token" | "threadId" | "threadChatId" | "featureFlags"
      >;
      runContext?: null;
    })
  | (SendDaemonMessageArgsBase & {
      message: DistributiveOmit<
        Extract<DaemonMessage, { type: "permission-response" }>,
        "token" | "threadId" | "threadChatId"
      >;
      runContext?: null;
    });

function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("relation") ||
    msg.includes("column") ||
    msg.includes("createapikey") ||
    msg.includes("database") ||
    msg.includes("connect econnrefused") ||
    msg.includes("violates") ||
    msg.includes("duplicate key")
  );
}

function classifyDaemonError(
  msg: string,
  error: unknown,
): {
  errorType: ThreadErrorType;
  failureCategory: DeliveryLoopFailureCategory;
} {
  if (isInfrastructureError(error)) {
    return { errorType: "unknown-error", failureCategory: "config_error" };
  }
  const lower = msg.toLowerCase();

  // Daemon process unreachable (socket gone, connection refused, ping failed)
  if (
    /unix socket|econnrefused|enoent.*socket|no such file|connect failed/i.test(
      msg,
    ) ||
    /daemon.*not running|daemon.*dead|ping.*fail/i.test(msg)
  ) {
    return {
      errorType: "agent-not-responding",
      failureCategory: "daemon_unreachable",
    };
  }

  // Daemon spawn/start failure
  if (/spawn|fork|exec|eacces|enoent.*daemon|cannot find module/i.test(msg)) {
    return {
      errorType: "agent-not-responding",
      failureCategory: "daemon_spawn_failed",
    };
  }

  // Dispatch acknowledgement timeout
  if (/timeout|timed out|ack.*timeout|dispatch.*timeout/i.test(msg)) {
    return {
      errorType: "agent-not-responding",
      failureCategory: "dispatch_ack_timeout",
    };
  }

  // Codex app-server exited
  if (/codex.*app.?server.*exit|app.?server.*crash/i.test(msg)) {
    return {
      errorType: "agent-generic-error",
      failureCategory: "codex_app_server_exit",
    };
  }

  // Codex turn/subagent failures
  if (/codex.*subagent|subagent.*fail/i.test(msg)) {
    return {
      errorType: "agent-generic-error",
      failureCategory: "codex_subagent_failed",
    };
  }
  if (/codex.*turn.*fail|codex.*error/i.test(msg)) {
    return {
      errorType: "agent-generic-error",
      failureCategory: "codex_turn_failed",
    };
  }

  // Claude runtime exit / dispatch failure
  if (/claude.*exit|claude.*crash|claude.*runtime/i.test(msg)) {
    return {
      errorType: "agent-generic-error",
      failureCategory: "claude_runtime_exit",
    };
  }
  if (/claude.*dispatch|dispatch.*fail/i.test(msg)) {
    return {
      errorType: "agent-generic-error",
      failureCategory: "claude_dispatch_failed",
    };
  }

  // Gate failures
  if (/gate.*fail|gate.*block/i.test(msg)) {
    return { errorType: "agent-generic-error", failureCategory: "gate_failed" };
  }

  // Generic daemon-related errors (message includes "daemon" but didn't match above)
  if (lower.includes("daemon") || lower.includes("write message")) {
    return { errorType: "agent-generic-error", failureCategory: "unknown" };
  }

  // Fallback
  return { errorType: "agent-not-responding", failureCategory: "unknown" };
}

export async function sendDaemonMessage({
  message,
  userId,
  threadId,
  threadChatId,
  sandboxId,
  session,
  runContext,
}: SendDaemonMessageArgs) {
  try {
    await setActiveThreadChat({
      sandboxId,
      threadChatId,
      isActive: true,
      runId: runContext?.runId ?? null,
    });

    let finalMessage: DaemonMessage;

    if (message.type === "claude") {
      if (!runContext) {
        throw new Error("run context is required for claude daemon messages");
      }
      const [{ token }, featureFlags] = await Promise.all([
        createDaemonRunCredentials({
          userId,
          threadId,
          threadChatId,
          sandboxId,
          runId: runContext.runId,
          tokenNonce: runContext.tokenNonce,
          agent: runContext.agent,
          transportMode: runContext.transportMode,
          protocolVersion: runContext.protocolVersion,
        }),
        getFeatureFlagsForUser({ db, userId }),
      ]);
      finalMessage = {
        ...message,
        token,
        threadId,
        threadChatId,
        featureFlags,
      };
    } else {
      const apiKey = await auth.api.createApiKey({
        body: {
          name: sandboxId,
          expiresIn: 60 * 60 * 24 * 1, // 1 day
          userId,
        },
      } as any);
      finalMessage = {
        ...message,
        token: apiKey.key,
        threadId,
        threadChatId,
      };
    }

    await sendMessage({
      session,
      message: finalMessage,
    });
  } catch (error) {
    if (message.type === "claude" && runContext) {
      try {
        await updateAgentRunContext({
          db,
          userId,
          runId: runContext.runId,
          updates: {
            status: "failed",
          },
        });
      } catch (updateError) {
        console.error("Failed to mark agent run context as failed", {
          runId: runContext.runId,
          error: updateError,
        });
      }
    }
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    const { errorType, failureCategory } = classifyDaemonError(
      errorMessage,
      error,
    );
    throw wrapError(errorType, error, failureCategory);
  }
}
