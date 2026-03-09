import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

export const codexImplementationAdapter: ImplementationRuntimeAdapter = {
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
    const transportEligible =
      input.permissionMode !== "plan" &&
      input.threadChatId !== "legacy-thread-chat-id";
    const transportMode =
      transportEligible && input.featureFlags.codexAppServerTransport
        ? ("codex-app-server" as const)
        : transportEligible && input.featureFlags.sandboxAgentAcpTransport
          ? ("acp" as const)
          : ("legacy" as const);
    const protocolVersion = transportMode === "acp" ? 2 : 1;

    let requestedSessionId = input.sessionId;
    let codexPreviousResponseId = input.codexPreviousResponseId;
    if (transportMode !== "codex-app-server") {
      codexPreviousResponseId = null;
    }
    if (transportMode === "acp") {
      requestedSessionId = null;
      codexPreviousResponseId = null;
    }

    return {
      transportMode,
      protocolVersion,
      requestedSessionId,
      codexPreviousResponseId,
      message: {
        type: "claude",
        model: input.normalizedModel,
        agent: input.agent,
        agentVersion: input.agentVersion,
        prompt: input.prompt,
        sessionId: requestedSessionId,
        codexPreviousResponseId,
        permissionMode: input.permissionMode,
        runId: input.runId,
        transportMode,
        protocolVersion,
        ...(transportMode === "acp"
          ? {
              acpServerId: `terragon-${input.runId}`,
              acpSessionId: input.sessionId ?? null,
            }
          : {}),
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
