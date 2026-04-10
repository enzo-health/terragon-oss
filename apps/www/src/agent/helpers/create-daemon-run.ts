import { auth } from "@/lib/auth";
import { AIAgent } from "@leo/agent/types";
import { updateAgentRunContext } from "@leo/shared/model/agent-run-context";
import { db } from "@/lib/db";

type DaemonTokenProvider = "openai" | "anthropic" | "google" | "openrouter";

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

export async function createDaemonRunCredentials({
  userId,
  threadId,
  threadChatId,
  sandboxId,
  runId,
  tokenNonce,
  agent,
  transportMode,
  protocolVersion,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
  runId: string;
  tokenNonce: string;
  agent: AIAgent;
  transportMode: "legacy" | "acp" | "codex-app-server";
  protocolVersion: 1 | 2;
}): Promise<{ token: string }> {
  const nowMs = Date.now();
  const daemonRunClaims = {
    kind: "daemon-run" as const,
    runId,
    threadId,
    threadChatId,
    sandboxId,
    agent,
    transportMode,
    protocolVersion,
    providers: providersForAgent(agent),
    nonce: tokenNonce,
    issuedAt: nowMs,
    exp: nowMs + 1000 * 60 * 60 * 24,
  };

  const apiKey = await auth.api.createApiKey({
    body: {
      name: sandboxId,
      expiresIn: 60 * 60 * 24 * 1, // 1 day
      userId,
      metadata: {
        daemonRun: daemonRunClaims,
      },
    },
  } as any);

  const daemonTokenKeyId =
    typeof (apiKey as { id?: unknown }).id === "string"
      ? ((apiKey as { id?: string }).id ?? null)
      : null;

  await updateAgentRunContext({
    db,
    userId,
    runId,
    updates: {
      daemonTokenKeyId,
      status: "dispatched",
    },
  });

  return { token: apiKey.key };
}
