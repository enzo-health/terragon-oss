import { AIAgent, AIAgentCredentials, AIModel } from "@terragon/agent/types";
import { getCodexCredentialsJSONOrNull } from "@/agent/msg/codexCredentials";
import { getClaudeCredentialsJSONOrNull } from "@/agent/msg/claudeCredentials";
import { ThreadError } from "./error";

export async function getAndVerifyCredentials({
  agent,
  model: _model,
  userId,
}: {
  agent: AIAgent;
  model: AIModel | null;
  userId: string;
}): Promise<AIAgentCredentials> {
  switch (agent) {
    case "codex": {
      const codexCredentials = await getCodexCredentialsJSONOrNull({ userId });
      if (codexCredentials.contents) {
        return {
          type: "json-file",
          contents: codexCredentials.contents,
        };
      }
      if (codexCredentials.error) {
        throw new ThreadError(
          "invalid-codex-credentials",
          codexCredentials.error,
          null,
        );
      }
      return {
        type: "built-in-credits",
      };
    }
    case "claudeCode": {
      const claudeCredentials = await getClaudeCredentialsJSONOrNull({
        userId,
      });
      if (claudeCredentials.contents) {
        return {
          type: "json-file",
          contents: claudeCredentials.contents,
        };
      }
      if (claudeCredentials.error) {
        throw new ThreadError(
          "invalid-claude-credentials",
          claudeCredentials.error,
          null,
        );
      }
      return {
        type: "built-in-credits",
      };
    }
    default: {
      const _exhaustiveCheck: never = agent;
      throw new Error(`Unknown agent: ${_exhaustiveCheck}`);
    }
  }
}
