import type { AIAgent } from "@terragon/agent/types";
import { claudeCodeImplementationAdapter } from "./claude-code-implementation-adapter";
import { codexImplementationAdapter } from "./codex-implementation-adapter";

export type ImplementationTransportMode = "legacy" | "acp" | "codex-app-server";

export type ImplementationTransportFeatureFlags = {
  sandboxAgentAcpTransport: boolean;
  codexAppServerTransport: boolean;
};

export type ImplementationDaemonMessage = {
  type: "claude";
  model: string;
  agent: AIAgent;
  agentVersion: number;
  prompt: string;
  sessionId: string | null;
  codexPreviousResponseId: string | null;
  permissionMode: "allowAll" | "plan";
  runId: string;
  transportMode: ImplementationTransportMode;
  protocolVersion: 1 | 2;
  acpServerId?: string;
  acpSessionId?: string | null;
  useCredits?: true;
};

export type ImplementationAdapterInput = {
  agent: AIAgent;
  agentVersion: number;
  normalizedModel: string;
  prompt: string;
  permissionMode: "allowAll" | "plan";
  runId: string;
  sessionId: string | null;
  codexPreviousResponseId: string | null;
  shouldUseCredits: boolean;
  threadChatId: string;
  featureFlags: ImplementationTransportFeatureFlags;
};

export type ImplementationDispatch = {
  transportMode: ImplementationTransportMode;
  protocolVersion: 1 | 2;
  requestedSessionId: string | null;
  codexPreviousResponseId: string | null;
  message: ImplementationDaemonMessage;
};

export interface ImplementationRuntimeAdapter {
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch;
}

const genericImplementationAdapter: ImplementationRuntimeAdapter = {
  createDispatch(input) {
    const supportsAcp = input.agent === "amp" || input.agent === "opencode";
    const transportEligible =
      input.permissionMode !== "plan" &&
      input.threadChatId !== "legacy-thread-chat-id";
    const transportMode =
      transportEligible &&
      input.featureFlags.sandboxAgentAcpTransport &&
      supportsAcp
        ? ("acp" as const)
        : ("legacy" as const);
    const protocolVersion = transportMode === "acp" ? 2 : 1;
    const requestedSessionId = transportMode === "acp" ? null : input.sessionId;

    return {
      transportMode,
      protocolVersion,
      requestedSessionId,
      codexPreviousResponseId: null,
      message: {
        type: "claude",
        model: input.normalizedModel,
        agent: input.agent,
        agentVersion: input.agentVersion,
        prompt: input.prompt,
        sessionId: requestedSessionId,
        codexPreviousResponseId: null,
        permissionMode: input.permissionMode,
        runId: input.runId,
        transportMode,
        protocolVersion,
        ...(transportMode === "acp"
          ? {
              acpServerId: `terragon-${input.runId}`,
              acpSessionId: input.sessionId ?? null,
            }
          : {}),
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};

export function resolveImplementationRuntimeAdapter(
  agent: AIAgent,
): ImplementationRuntimeAdapter {
  switch (agent) {
    case "codex":
      return codexImplementationAdapter;
    case "claudeCode":
      return claudeCodeImplementationAdapter;
    case "amp":
    case "gemini":
    case "opencode":
      return genericImplementationAdapter;
    default: {
      const _exhaustiveCheck: never = agent;
      throw new Error(
        `Unhandled implementation adapter agent: ${_exhaustiveCheck}`,
      );
    }
  }
}
