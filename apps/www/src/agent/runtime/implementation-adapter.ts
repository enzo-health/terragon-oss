import type { AIAgent } from "@terragon/agent/types";
import type { RuntimeAdapterContract } from "@terragon/daemon/shared";
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
  runtimeAdapterContract: RuntimeAdapterContract;
  useCredits?: true;
};

export type ImplementationAdapterInput = {
  agent: AIAgent;
  agentVersion: number;
  normalizedModel: string;
  prompt: string;
  permissionMode: "allowAll" | "plan";
  runId: string;
  threadChatId: string;
  sessionId: string | null;
  codexPreviousResponseId: string | null;
  shouldUseCredits: boolean;
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
  contract(input: ImplementationAdapterInput): RuntimeAdapterContract;
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch;
}

export function resolveImplementationRuntimeAdapter(
  agent: AIAgent,
): ImplementationRuntimeAdapter {
  switch (agent) {
    case "codex":
      return codexImplementationAdapter;
    case "claudeCode":
      return claudeCodeImplementationAdapter;
    default: {
      const _exhaustiveCheck: never = agent;
      throw new Error(
        `Unhandled implementation adapter agent: ${_exhaustiveCheck}`,
      );
    }
  }
}
