import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

export const codexImplementationAdapter: ImplementationRuntimeAdapter = {
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
    const codexAppServerEligible =
      input.permissionMode !== "plan" &&
      input.threadChatId !== "legacy-thread-chat-id";

    if (codexAppServerEligible) {
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
    }

    // Plan mode or legacy-thread-chat-id: fall back to ACP
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
