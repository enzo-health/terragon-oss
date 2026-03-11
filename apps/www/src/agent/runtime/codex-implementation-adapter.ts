import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

export const codexImplementationAdapter: ImplementationRuntimeAdapter = {
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
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
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
