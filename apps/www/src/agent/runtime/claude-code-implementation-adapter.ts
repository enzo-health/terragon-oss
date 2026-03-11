import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

export const claudeCodeImplementationAdapter: ImplementationRuntimeAdapter = {
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
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
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
