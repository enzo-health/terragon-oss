import { codexRuntimeAdapterContract } from "@terragon/daemon/runtime-contracts";
import type { RuntimeAdapterContract } from "@terragon/daemon/shared";
import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

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
