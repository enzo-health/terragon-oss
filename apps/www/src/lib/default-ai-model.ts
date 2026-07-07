import { AIModel } from "@terragon/agent/types";
import { getDefaultModelForAgent } from "@terragon/agent/utils";
import { UserCredentials } from "@terragon/shared";
import { UserFlags } from "@terragon/shared";

export function getDefaultModel({
  userCredentials,
  userFlags,
}: {
  userCredentials: Pick<UserCredentials, "hasClaude" | "hasOpenAI"> | null;
  userFlags: UserFlags | null;
}): AIModel {
  if (userFlags?.selectedModel) {
    return userFlags.selectedModel;
  }
  if (!userCredentials?.hasClaude && userCredentials?.hasOpenAI) {
    return getDefaultModelForAgent({ agent: "codex", agentVersion: "latest" });
  }
  return getDefaultModelForAgent({
    agent: "claudeCode",
    agentVersion: "latest",
  });
}

export function getCannotUseOpus({
  userFlags: _userFlags,
}: {
  userFlags: UserFlags | null;
}): boolean {
  return false;
}
