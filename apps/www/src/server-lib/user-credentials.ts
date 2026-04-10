import { db } from "@/lib/db";
import { getAllAgentProviderCredentialRecords } from "@leo/shared/model/agent-provider-credentials";
import { UserCredentials } from "@leo/shared";

export async function getUserCredentials({
  userId,
}: {
  userId: string;
}): Promise<UserCredentials> {
  const agentProviderCredentials = await getAllAgentProviderCredentialRecords({
    db,
    userId,
    isActive: true,
  });
  const result: UserCredentials = {
    hasClaude: false,
    hasAmp: false,
    hasOpenAI: false,
    hasOpenAIOAuthCredentials: false,
  };
  for (const credential of agentProviderCredentials) {
    switch (credential.agent) {
      case "claudeCode":
        result.hasClaude = true;
        break;
      case "codex":
        result.hasOpenAI = true;
        result.hasOpenAIOAuthCredentials =
          result.hasOpenAIOAuthCredentials || credential.type === "oauth";
        break;
      case "amp":
        result.hasAmp = true;
        break;
    }
  }
  return result;
}
