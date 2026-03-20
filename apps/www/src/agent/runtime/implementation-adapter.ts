import type { AIAgent } from "@terragon/agent/types";
import { claudeCodeImplementationAdapter } from "./claude-code-implementation-adapter";
import { codexImplementationAdapter } from "./codex-implementation-adapter";

export type ImplementationTransportMode = "legacy" | "acp" | "codex-app-server";

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
  enableAcpTransport?: boolean;
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
    const supportsAcp =
      input.agent !== "gemini" && input.enableAcpTransport !== false;

    if (supportsAcp) {
      return {
        transportMode: "acp" as const,
        protocolVersion: 2 as const,
        requestedSessionId: null,
        codexPreviousResponseId: null,
        message: {
          type: "claude",
          model: input.normalizedModel,
          agent: input.agent,
          agentVersion: input.agentVersion,
          prompt: input.prompt,
          sessionId: null,
          codexPreviousResponseId: null,
          permissionMode: input.permissionMode,
          runId: input.runId,
          transportMode: "acp" as const,
          protocolVersion: 2 as const,
          acpServerId: `terragon-${input.runId}`,
          acpSessionId: input.sessionId ?? null,
          ...(input.shouldUseCredits ? { useCredits: true } : {}),
        },
      };
    }

    // Gemini: legacy transport (ACP not supported)
    return {
      transportMode: "legacy" as const,
      protocolVersion: 1 as const,
      requestedSessionId: input.sessionId,
      codexPreviousResponseId: null,
      message: {
        type: "claude",
        model: input.normalizedModel,
        agent: input.agent,
        agentVersion: input.agentVersion,
        prompt: input.prompt,
        sessionId: input.sessionId,
        codexPreviousResponseId: null,
        permissionMode: input.permissionMode,
        runId: input.runId,
        transportMode: "legacy" as const,
        protocolVersion: 1 as const,
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
