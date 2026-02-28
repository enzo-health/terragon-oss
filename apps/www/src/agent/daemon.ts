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

type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

type RunContext = {
  runId: string;
  tokenNonce: string;
  transportMode: "legacy" | "acp";
  protocolVersion: 1 | 2;
  agent: AIAgent;
};

type DaemonTokenProvider = "openai" | "anthropic" | "google" | "openrouter";

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
    });

function providersForAgent(agent: AIAgent): DaemonTokenProvider[] {
  switch (agent) {
    case "claudeCode":
      return ["anthropic"];
    case "codex":
      return ["openai"];
    case "gemini":
      return ["google"];
    case "amp":
      return ["anthropic"];
    case "opencode":
      return ["openrouter", "openai", "anthropic"];
    default: {
      const _exhaustiveCheck: never = agent;
      throw new Error(
        `unsupported agent for daemon token scope: ${_exhaustiveCheck}`,
      );
    }
  }
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
    const nowMs = Date.now();
    let daemonRunClaims: {
      kind: "daemon-run";
      runId: string;
      threadId: string;
      threadChatId: string;
      sandboxId: string;
      agent: AIAgent;
      transportMode: "legacy" | "acp";
      protocolVersion: 1 | 2;
      providers: DaemonTokenProvider[];
      nonce: string;
      issuedAt: number;
      exp: number;
    } | null = null;
    if (message.type === "claude") {
      if (!runContext) {
        throw new Error("run context is required for claude daemon messages");
      }
      daemonRunClaims = {
        kind: "daemon-run" as const,
        runId: runContext.runId,
        threadId,
        threadChatId,
        sandboxId,
        agent: runContext.agent,
        transportMode: runContext.transportMode,
        protocolVersion: runContext.protocolVersion,
        providers: providersForAgent(runContext.agent),
        nonce: runContext.tokenNonce,
        issuedAt: nowMs,
        exp: nowMs + 1000 * 60 * 60 * 24,
      };
    }
    const [apiKey, featureFlags] = await Promise.all([
      auth.api.createApiKey({
        body: {
          name: sandboxId,
          expiresIn: 60 * 60 * 24 * 1, // 1 day,
          userId,
          ...(daemonRunClaims
            ? {
                metadata: JSON.stringify({
                  daemonRun: daemonRunClaims,
                }),
              }
            : {}),
        },
      } as any),
      getFeatureFlagsForUser({ db, userId }),
    ]);

    if (daemonRunClaims) {
      await updateAgentRunContext({
        db,
        userId,
        runId: daemonRunClaims.runId,
        updates: {
          daemonTokenKeyId:
            typeof (apiKey as { id?: unknown }).id === "string"
              ? ((apiKey as { id?: string }).id ?? null)
              : null,
          status: "dispatched",
        },
      });
    }

    const baseMessage = {
      ...message,
      token: apiKey.key,
      threadId,
      threadChatId,
    };

    const finalMessage: DaemonMessage =
      baseMessage.type === "claude"
        ? {
            ...baseMessage,
            featureFlags: featureFlags,
          }
        : baseMessage;

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
    throw wrapError("agent-not-responding", error);
  }
}
