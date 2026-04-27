import type { AIAgent } from "@terragon/agent/types";
import { claudeCodeImplementationAdapter } from "./claude-code-implementation-adapter";
import { codexImplementationAdapter } from "./codex-implementation-adapter";

export type ImplementationTransportMode = "legacy" | "acp" | "codex-app-server";

export type RuntimeAdapterOperation =
  | "start"
  | "resume"
  | "stop"
  | "restart"
  | "retry"
  | "permission-response"
  | "event-normalization"
  | "compact-and-retry"
  | "human-intervention";

export type RuntimeAdapterOperationSupport =
  | { status: "supported" }
  | {
      status: "unsupported";
      reason: string;
      recovery: "retry-new-run" | "manual-intervention" | "legacy-fallback";
    };

export type RuntimeSessionPersistenceContract = {
  requestedSessionField: "sessionId" | "acpSessionId" | null;
  resolvedSessionField:
    | "sessionId"
    | "acpSessionId"
    | "codexPreviousResponseId"
    | null;
  previousResponseField: "codexPreviousResponseId" | null;
};

export type RuntimeAdapterContract = {
  adapterId: "codex-app-server" | "claude-acp" | "legacy";
  transportMode: ImplementationTransportMode;
  protocolVersion: 1 | 2;
  session: RuntimeSessionPersistenceContract;
  operations: Record<RuntimeAdapterOperation, RuntimeAdapterOperationSupport>;
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

export function unsupportedRuntimeOperation(
  reason: string,
  recovery: "retry-new-run" | "manual-intervention" | "legacy-fallback",
): RuntimeAdapterOperationSupport {
  return { status: "unsupported", reason, recovery };
}

export function createRuntimeOperations(
  supported: RuntimeAdapterOperation[],
  unsupported: Partial<
    Record<
      RuntimeAdapterOperation,
      {
        reason: string;
        recovery: "retry-new-run" | "manual-intervention" | "legacy-fallback";
      }
    >
  >,
): Record<RuntimeAdapterOperation, RuntimeAdapterOperationSupport> {
  const supportedSet = new Set<RuntimeAdapterOperation>(supported);
  const allOperations: RuntimeAdapterOperation[] = [
    "start",
    "resume",
    "stop",
    "restart",
    "retry",
    "permission-response",
    "event-normalization",
    "compact-and-retry",
    "human-intervention",
  ];
  const result = {} as Record<
    RuntimeAdapterOperation,
    RuntimeAdapterOperationSupport
  >;
  for (const operation of allOperations) {
    if (supportedSet.has(operation)) {
      result[operation] = { status: "supported" };
      continue;
    }
    const unsupportedDetails = unsupported[operation] ?? {
      reason: `${operation} is not implemented by this runtime adapter`,
      recovery: "manual-intervention" as const,
    };
    result[operation] = unsupportedRuntimeOperation(
      unsupportedDetails.reason,
      unsupportedDetails.recovery,
    );
  }
  return result;
}

export const legacyRuntimeAdapterContract: RuntimeAdapterContract = {
  adapterId: "legacy",
  transportMode: "legacy",
  protocolVersion: 1,
  session: {
    requestedSessionField: "sessionId",
    resolvedSessionField: "sessionId",
    previousResponseField: null,
  },
  operations: createRuntimeOperations(
    ["start", "resume", "stop", "retry", "event-normalization"],
    {
      restart: {
        reason:
          "Legacy stream-json processes are single-turn child processes; restart is represented as a new run.",
        recovery: "retry-new-run",
      },
      "permission-response": {
        reason:
          "Legacy stream-json permission prompts are not addressable by daemon operation id.",
        recovery: "manual-intervention",
      },
      "compact-and-retry": {
        reason:
          "Compaction is handled before dispatch and retried as a fresh legacy run.",
        recovery: "retry-new-run",
      },
      "human-intervention": {
        reason:
          "Human intervention is surfaced as a terminal recovery result, not a legacy adapter operation.",
        recovery: "manual-intervention",
      },
    },
  ),
};

const genericImplementationAdapter: ImplementationRuntimeAdapter = {
  contract(input) {
    const supportsAcp =
      input.agent !== "gemini" && input.enableAcpTransport !== false;
    if (supportsAcp) {
      return {
        adapterId: "claude-acp",
        transportMode: "acp",
        protocolVersion: 2,
        session: {
          requestedSessionField: "acpSessionId",
          resolvedSessionField: "acpSessionId",
          previousResponseField: null,
        },
        operations: createRuntimeOperations(
          [
            "start",
            "resume",
            "stop",
            "retry",
            "permission-response",
            "event-normalization",
          ],
          {
            restart: {
              reason:
                "Claude ACP server restart is sandbox-agent bootstrap recovery; user retry starts a fresh run.",
              recovery: "retry-new-run",
            },
            "compact-and-retry": {
              reason:
                "Compaction is emitted as a typed recovery result before another ACP run.",
              recovery: "retry-new-run",
            },
            "human-intervention": {
              reason:
                "Human intervention is surfaced as a terminal recovery result, not an ACP operation.",
              recovery: "manual-intervention",
            },
          },
        ),
      };
    }
    return legacyRuntimeAdapterContract;
  },
  createDispatch(input) {
    const contract = this.contract(input);
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
          runtimeAdapterContract: contract,
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
        runtimeAdapterContract: contract,
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
