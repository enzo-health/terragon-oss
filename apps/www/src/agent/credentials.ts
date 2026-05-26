import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { AIAgent, AIAgentCredentials, AIModel } from "@terragon/agent/types";
import { getAgentProviderCredentialsDecrypted } from "@terragon/shared/model/agent-provider-credentials";
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
    case "amp": {
      const ampCredentials = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "amp",
        encryptionKey: env.ENCRYPTION_MASTER_KEY,
      });
      const ampApiKey = ampCredentials?.apiKey ?? null;
      if (!ampApiKey) {
        throw new ThreadError(
          "missing-amp-credentials",
          "User does not have Amp API key.",
          null,
        );
      }
      return {
        type: "env-var",
        key: "AMP_API_KEY",
        value: ampApiKey,
      };
    }
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
    case "droid": {
      const droidCredentials = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "droid",
        encryptionKey: env.ENCRYPTION_MASTER_KEY,
      });
      const droidApiKey = droidCredentials?.apiKey ?? null;
      if (!droidApiKey) {
        throw new ThreadError(
          "missing-droid-credentials",
          "User does not have Droid API key.",
          null,
        );
      }
      return {
        type: "env-var",
        key: "FACTORY_API_KEY",
        value: droidApiKey,
      };
    }
    case "gemini":
    case "opencode": {
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
