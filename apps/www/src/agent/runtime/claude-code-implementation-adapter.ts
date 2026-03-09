import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

export const claudeCodeImplementationAdapter: ImplementationRuntimeAdapter = {
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
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
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
