import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
  RuntimeAdapterContract,
} from "./implementation-adapter";
import {
  createRuntimeOperations,
  legacyRuntimeAdapterContract,
} from "./implementation-adapter";

export const claudeAcpRuntimeAdapterContract: RuntimeAdapterContract = {
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

export const claudeCodeImplementationAdapter: ImplementationRuntimeAdapter = {
  contract(input: ImplementationAdapterInput): RuntimeAdapterContract {
    if (input.enableAcpTransport === false) {
      return legacyRuntimeAdapterContract;
    }
    return claudeAcpRuntimeAdapterContract;
  },
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
    const contract = this.contract(input);
    if (input.enableAcpTransport === false) {
      return {
        transportMode: "legacy",
        protocolVersion: 1,
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
          transportMode: "legacy",
          protocolVersion: 1,
          runtimeAdapterContract: contract,
          ...(input.shouldUseCredits ? { useCredits: true } : {}),
        },
      };
    }

    return {
      transportMode: "acp",
      protocolVersion: 2,
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
        transportMode: "acp",
        protocolVersion: 2,
        acpServerId: `terragon-${input.runId}`,
        acpSessionId: input.sessionId ?? null,
        runtimeAdapterContract: contract,
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
