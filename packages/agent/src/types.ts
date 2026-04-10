import * as z from "zod/v4";

export const AIModelSchema = z.enum([
  // claude code
  "opus",
  "opus[1m]",
  "sonnet",
  "sonnet[1m]",
  "haiku",

  // gemini
  "gemini-2.5-pro",
  "gemini-3-pro",

  // amp
  "amp",

  // codex
  "gpt-5.4-low",
  "gpt-5.4",
  "gpt-5.4-high",
  "gpt-5.4-xhigh",
  "gpt-5.4-mini-low",
  "gpt-5.4-mini",
  "gpt-5.4-mini-high",
  "gpt-5.4-mini-xhigh",
  "gpt-5.4-nano-low",
  "gpt-5.4-nano",
  "gpt-5.4-nano-high",
  "gpt-5.4-nano-xhigh",
  "gpt-5",
  "gpt-5-low",
  "gpt-5-high",
  "gpt-5-codex-low",
  "gpt-5-codex-medium",
  "gpt-5-codex-high",
  "gpt-5.2-low",
  "gpt-5.2",
  "gpt-5.2-high",
  "gpt-5.2-xhigh",
  "gpt-5.1",
  "gpt-5.1-low",
  "gpt-5.1-high",
  "gpt-5.1-codex-low",
  "gpt-5.1-codex-medium",
  "gpt-5.1-codex-high",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-low",
  "gpt-5.1-codex-max-high",
  "gpt-5.1-codex-max-xhigh",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-medium",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-xhigh",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-medium",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-spark-low",
  "gpt-5.3-codex-spark-medium",
  "gpt-5.3-codex-spark-high",

  // opencode
  "opencode/grok-code",
  "opencode/qwen3-coder",
  "opencode/kimi-k2.5",
  "opencode/glm-5.1",
  "opencode/gemini-2.5-pro",
  "opencode/gemini-3-pro",
  "opencode-oai/gpt-5",
  "opencode-oai/gpt-5-codex",
  "opencode-ant/sonnet",
]);

// Augment AIModelSchema with simpler names for external usage
export const AIModelExternalSchema = z.enum([
  ...AIModelSchema.options,
  "gpt-5.4-medium",
  "gpt-5.4-mini-medium",
  "gpt-5.4-nano-medium",
  "gpt-5-medium",
  "gpt-5.1-medium",
  "gpt-5.2-medium",
  "gpt-5-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max-medium",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "grok-code",
  "qwen3-coder",
  "kimi-k2.5",
  "glm-5.1",
  "opencode/gpt-5",
  "opencode/gpt-5-codex",
  "opencode/sonnet",
]);

export type AIModel = z.infer<typeof AIModelSchema>;
export type AIModelExternal = z.infer<typeof AIModelExternalSchema>;

export const AIAgentSchema = z.enum([
  "claudeCode",
  "gemini",
  "amp",
  "codex",
  "opencode",
]);

export type AIAgent = z.infer<typeof AIAgentSchema>;

export type AIAgentCredentials =
  | { type: "env-var"; key: string; value: string }
  | { type: "json-file"; contents: string }
  | { type: "built-in-credits" };

export type AIAgentSlashCommand = {
  name: string;
  description: string;
  isLoading?: boolean;
};

export type SelectedAIModels = {
  [model in AIModel]?: number;
};

export type AgentModelPreferences = {
  agents?: { [agent in AIAgent]?: boolean };
  models?: { [model in AIModel]?: boolean };
};
