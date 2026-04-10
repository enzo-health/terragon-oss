import { describe, it, expect } from "vitest";
import {
  modelToAgent,
  agentToModels,
  sortByAgents,
  getAgentModelGroups,
  parseModelOrNull,
  normalizedModelForDaemon,
  shouldUseCredits,
} from "./utils";
import { AIModel, AIAgent } from "./types";
import { AGENT_VERSION } from "./versions";

const options = {
  agentVersion: AGENT_VERSION,
  enableOpenRouterOpenAIAnthropicModel: true,
  enableOpencodeGemini3ProModelOption: true,
};

describe("model-to-agent", () => {
  describe("modelToAgent and agentToModels consistency", () => {
    it("should have bidirectional consistency between functions", () => {
      const agents: AIAgent[] = ["claudeCode", "gemini", "amp", "codex"];

      agents.forEach((agent) => {
        const models = agentToModels(agent, options);
        models.forEach((model) => {
          expect(modelToAgent(model)).toBe(agent);
        });
      });
    });

    it("should map all models back to their original agents", () => {
      const modelAgentPairs: [AIModel, AIAgent][] = [
        ["opus", "claudeCode"],
        ["opus[1m]", "claudeCode"],
        ["sonnet", "claudeCode"],
        ["sonnet[1m]", "claudeCode"],
        ["gemini-2.5-pro", "gemini"],
        ["amp", "amp"],
        ["gpt-5.4-low", "codex"],
        ["gpt-5.4", "codex"],
        ["gpt-5.4-high", "codex"],
        ["gpt-5.4-xhigh", "codex"],
        ["gpt-5.4-mini", "codex"],
        ["gpt-5.4-nano", "codex"],
      ];

      modelAgentPairs.forEach(([model, expectedAgent]) => {
        const agent = modelToAgent(model);
        expect(agent).toBe(expectedAgent);
        const models = agentToModels(agent, options);
        expect(models).toContain(model);
      });
    });
  });

  describe("sortByAgents", () => {
    it("should sort agents by their order", () => {
      const agents: AIAgent[] = ["claudeCode", "gemini", "amp", "codex"];
      const sortedAgents = agents.sort(sortByAgents);
      expect(sortedAgents).toEqual(["claudeCode", "codex", "gemini", "amp"]);
    });
  });

  describe("getAgentModelGroups", () => {
    it("should include selected models even when disabled by preferences", () => {
      const result = getAgentModelGroups({
        agent: "claudeCode",
        agentModelPreferences: {
          models: {
            opus: false, // Opus is disabled
            sonnet: true,
            haiku: true,
          },
        },
        selectedModels: ["opus"], // But opus is currently selected
        options,
      });

      expect(result.models).toContain("opus");
      expect(result.models).toContain("sonnet");
      expect(result.models).toContain("haiku");
    });

    it("should filter out disabled models when not selected", () => {
      const result = getAgentModelGroups({
        agent: "claudeCode",
        agentModelPreferences: {
          models: {
            opus: false, // Opus is disabled
            sonnet: true,
            haiku: true,
          },
        },
        selectedModels: [], // Opus is not selected
        options,
      });

      expect(result.models).not.toContain("opus");
      expect(result.models).toContain("sonnet");
      expect(result.models).toContain("haiku");
    });

    it("should use default preferences when not specified", () => {
      const result = getAgentModelGroups({
        agent: "codex",
        agentModelPreferences: { models: {} },
        selectedModels: [],
        options,
      });
      expect(result.models).toContain("gpt-5.4");
      expect(result.models).toContain("gpt-5.4-mini");
      expect(result.models).not.toContain("gpt-5.3-codex-medium");
    });

    it("should keep legacy codex models for older agent versions", () => {
      const result = getAgentModelGroups({
        agent: "codex",
        agentModelPreferences: { models: {} },
        selectedModels: [],
        options: {
          ...options,
          agentVersion: 4,
        },
      });

      expect(result.models).toContain("gpt-5.3-codex-medium");
      expect(result.models).not.toContain("gpt-5.4");
    });
  });

  describe("parseModelOrNull", () => {
    it("should parse exact model names", () => {
      expect(parseModelOrNull({ modelName: "opus" })).toBe("opus");
      expect(parseModelOrNull({ modelName: "opus[1m]" })).toBe("opus[1m]");
      expect(parseModelOrNull({ modelName: "sonnet" })).toBe("sonnet");
      expect(parseModelOrNull({ modelName: "sonnet[1m]" })).toBe("sonnet[1m]");
      expect(parseModelOrNull({ modelName: "haiku" })).toBe("haiku");
      expect(parseModelOrNull({ modelName: "gpt-5.4" })).toBe("gpt-5.4");
      expect(parseModelOrNull({ modelName: "gpt-5.4-mini" })).toBe(
        "gpt-5.4-mini",
      );
      expect(parseModelOrNull({ modelName: "gpt-5.4-nano" })).toBe(
        "gpt-5.4-nano",
      );
      expect(parseModelOrNull({ modelName: "gpt-5" })).toBe("gpt-5");
      expect(parseModelOrNull({ modelName: "gpt-5.1-codex-max" })).toBe(
        "gpt-5.1-codex-max",
      );
      expect(parseModelOrNull({ modelName: "gemini-2.5-pro" })).toBe(
        "gemini-2.5-pro",
      );
      expect(parseModelOrNull({ modelName: "opencode/grok-code" })).toBe(
        "opencode/grok-code",
      );
    });

    it("should parse shortcut model names with opencode/ prefix", () => {
      expect(parseModelOrNull({ modelName: "grok-code" })).toBe(
        "opencode/grok-code",
      );
      expect(parseModelOrNull({ modelName: "qwen3-coder" })).toBe(
        "opencode/qwen3-coder",
      );
      expect(parseModelOrNull({ modelName: "kimi-k2" })).toBe(
        "opencode/kimi-k2",
      );
      expect(parseModelOrNull({ modelName: "gpt-5.1-codex-max-medium" })).toBe(
        "gpt-5.1-codex-max",
      );
      expect(parseModelOrNull({ modelName: "gpt-5.4-medium" })).toBe("gpt-5.4");
      expect(parseModelOrNull({ modelName: "gpt-5.4-mini-medium" })).toBe(
        "gpt-5.4-mini",
      );
      expect(parseModelOrNull({ modelName: "gpt-5.4-nano-medium" })).toBe(
        "gpt-5.4-nano",
      );
      expect(parseModelOrNull({ modelName: "glm-4.6" })).toBe(
        "opencode/glm-4.6",
      );
    });

    it("should return null for invalid model names", () => {
      expect(parseModelOrNull({ modelName: "invalid-model" })).toBe(null);
      expect(parseModelOrNull({ modelName: "" })).toBe(null);
      expect(parseModelOrNull({ modelName: "gpt-4" })).toBe(null);
    });
  });

  describe("normalizedModelForDaemon", () => {
    it("should normalize Claude 1M shortcuts to explicit model IDs", () => {
      expect(normalizedModelForDaemon("sonnet[1m]")).toBe(
        "claude-sonnet-4-6[1m]",
      );
      expect(normalizedModelForDaemon("opus[1m]")).toBe("claude-opus-4-6[1m]");
    });
  });
});

describe("shouldUseCredits", () => {
  const withBoth = { hasOpenAI: true, hasClaude: true };
  const withNeither = { hasOpenAI: false, hasClaude: false };

  it("returns false for codex when user has OpenAI credentials", () => {
    expect(
      shouldUseCredits("codex", { hasOpenAI: true, hasClaude: false }),
    ).toBe(false);
  });

  it("returns true for codex when user lacks OpenAI credentials", () => {
    expect(
      shouldUseCredits("codex", { hasOpenAI: false, hasClaude: true }),
    ).toBe(true);
  });

  it("returns false for claudeCode when user has Claude credentials", () => {
    expect(
      shouldUseCredits("claudeCode", { hasOpenAI: false, hasClaude: true }),
    ).toBe(false);
  });

  it("returns true for claudeCode when user lacks Claude credentials", () => {
    expect(
      shouldUseCredits("claudeCode", { hasOpenAI: true, hasClaude: false }),
    ).toBe(true);
  });

  it("returns true for agents without connected credentials support", () => {
    // gemini and opencode don't support connected credentials
    expect(shouldUseCredits("gemini", withBoth)).toBe(true);
    expect(shouldUseCredits("opencode", withBoth)).toBe(true);
  });

  it("returns false for amp with any credentials (supports connected credentials)", () => {
    expect(shouldUseCredits("amp", withBoth)).toBe(false);
    expect(shouldUseCredits("amp", withNeither)).toBe(false);
  });

  it("returns true when user has no credentials at all", () => {
    expect(shouldUseCredits("codex", withNeither)).toBe(true);
    expect(shouldUseCredits("claudeCode", withNeither)).toBe(true);
  });
});
