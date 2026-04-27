import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
  RuntimeAdapterContract,
} from "./implementation-adapter";
import { createRuntimeOperations } from "./implementation-adapter";

export const codexRuntimeAdapterContract: RuntimeAdapterContract = {
  adapterId: "codex-app-server",
  transportMode: "codex-app-server",
  protocolVersion: 1,
  session: {
    requestedSessionField: "sessionId",
    resolvedSessionField: "sessionId",
    previousResponseField: "codexPreviousResponseId",
  },
  operations: createRuntimeOperations(
    ["start", "resume", "stop", "retry", "event-normalization"],
    {
      restart: {
        reason:
          "Codex app-server process restarts are operational recovery; user restart/retry is a new run.",
        recovery: "retry-new-run",
      },
      "permission-response": {
        reason:
          "Codex app-server does not expose Terragon-addressable pending permission requests.",
        recovery: "manual-intervention",
      },
      "compact-and-retry": {
        reason:
          "Compaction is emitted as a typed recovery result before starting another Codex turn.",
        recovery: "retry-new-run",
      },
      "human-intervention": {
        reason:
          "Human intervention is surfaced as a terminal recovery result, not a Codex app-server operation.",
        recovery: "manual-intervention",
      },
    },
  ),
};

export const codexImplementationAdapter: ImplementationRuntimeAdapter = {
  contract(): RuntimeAdapterContract {
    return codexRuntimeAdapterContract;
  },
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
    const contract = this.contract(input);
    return {
      transportMode: "codex-app-server",
      protocolVersion: 1,
      requestedSessionId: input.sessionId,
      codexPreviousResponseId: input.codexPreviousResponseId,
      message: {
        type: "claude",
        model: input.normalizedModel,
        agent: input.agent,
        agentVersion: input.agentVersion,
        prompt: input.prompt,
        sessionId: input.sessionId,
        codexPreviousResponseId: input.codexPreviousResponseId,
        permissionMode: input.permissionMode,
        runId: input.runId,
        transportMode: "codex-app-server",
        protocolVersion: 1,
        runtimeAdapterContract: contract,
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
