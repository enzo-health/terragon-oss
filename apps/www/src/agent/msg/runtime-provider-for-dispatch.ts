import type { AIAgent } from "@terragon/agent/types";
import type { RuntimeAdapterContract } from "@terragon/daemon/shared";
import type { AgentRuntimeProvider } from "@terragon/shared/db/types";

export function runtimeProviderForDispatch({
  agent,
  adapterId,
}: {
  agent: AIAgent;
  adapterId: RuntimeAdapterContract["adapterId"];
}): AgentRuntimeProvider {
  switch (adapterId) {
    case "codex-app-server":
      return "codex-app-server";
    case "claude-acp":
      return "claude-acp";
    case "legacy": {
      switch (agent) {
        case "claudeCode":
          return "legacy-claude";
        case "gemini":
          return "legacy-gemini";
        case "amp":
          return "legacy-amp";
        case "opencode":
          return "legacy-opencode";
        case "codex":
          return "codex-app-server";
        case "droid":
          return "legacy-droid";
        default: {
          const _exhaustiveCheck: never = agent;
          throw new Error(
            `unsupported legacy runtime provider for ${_exhaustiveCheck}`,
          );
        }
      }
    }
    default: {
      const _exhaustiveCheck: never = adapterId;
      throw new Error(`unsupported runtime adapter ${_exhaustiveCheck}`);
    }
  }
}
