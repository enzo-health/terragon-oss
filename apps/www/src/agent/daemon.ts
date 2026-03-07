import { auth } from "@/lib/auth";
import { DaemonMessage } from "@terragon/daemon/shared";
import { ISandboxSession } from "@terragon/sandbox/types";
import { sendMessage } from "@terragon/sandbox/daemon";
import { setActiveThreadChat } from "./sandbox-resource";
import { wrapError } from "./error";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { db } from "@/lib/db";
import { updateAgentRunContext } from "@terragon/shared/model/agent-run-context";
import { AIAgent } from "@terragon/agent/types";
import { createDaemonRunCredentials } from "@/agent/helpers/create-daemon-run";

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
    await setActiveThreadChat({ sandboxId, threadChatId, isActive: true });

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
    const errorType = isInfrastructureError(error)
      ? "unknown-error"
      : "agent-not-responding";
    throw wrapError(errorType, error);
  }
}
