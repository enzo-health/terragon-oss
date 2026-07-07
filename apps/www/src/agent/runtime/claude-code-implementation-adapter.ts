import { claudeAcpRuntimeAdapterContract } from "@terragon/daemon/runtime-contracts";
import type { RuntimeAdapterContract } from "@terragon/daemon/shared";
import type {
  ImplementationAdapterInput,
  ImplementationDispatch,
  ImplementationRuntimeAdapter,
} from "./implementation-adapter";

export const claudeCodeImplementationAdapter: ImplementationRuntimeAdapter = {
  contract(): RuntimeAdapterContract {
    return claudeAcpRuntimeAdapterContract;
  },
  createDispatch(input: ImplementationAdapterInput): ImplementationDispatch {
    const contract = this.contract(input);
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
        acpServerId: `terragon-thread-chat-${input.threadChatId}`,
        acpSessionId: input.sessionId ?? null,
        runtimeAdapterContract: contract,
        ...(input.shouldUseCredits ? { useCredits: true } : {}),
      },
    };
  },
};
