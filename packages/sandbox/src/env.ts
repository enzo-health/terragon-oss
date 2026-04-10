import { AIAgentCredentials } from "@leo/agent/types";

export function getEnv({
  userEnv,
  githubAccessToken,
  agentCredentials,
  overrides,
}: {
  githubAccessToken: string;
  userEnv: Array<{ key: string; value: string }>;
  agentCredentials: AIAgentCredentials | null;
  overrides?: Record<string, string>;
}) {
  const env: Record<string, string> = {
    // Indicates the agent is running in a Leo sandbox environment
    LEO: "true",
    // Set default GH_TOKEN from GitHub access token
    // This can be overridden if user provides their own GH_TOKEN
    GH_TOKEN: githubAccessToken,
  };

  // User environment variables take precedence over built-in variables
  for (const { key, value } of userEnv) {
    env[key] = value;
  }

  if (agentCredentials) {
    if (agentCredentials.type === "env-var") {
      env[agentCredentials.key] = agentCredentials.value;
    }
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
