import { describe, it, expect } from "vitest";
import { buildOpencodeConfig, getModelId } from "./opencode-config";
import { agentToModels } from "@terragon/agent/utils";
import { validateProviderModel } from "@terragon/agent/proxy";

describe("buildOpencodeConfig", () => {
  it("should build a valid opencode config", () => {
    const config = buildOpencodeConfig({
      publicUrl: "https://www.terragonlabs.com",
      userMcpConfig: {
        mcpServers: {
          terry: {
            command: "npx",
            args: ["-y", "terry", "mcp"],
            env: {
              DAEMON_TOKEN: "test-token",
            },
          },
        },
      },
    });
    expect(config).toMatchInlineSnapshot(`
      "{
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": false,
        "mcp": {
          "terry": {
            "type": "local",
            "command": [
              "npx",
              "-y",
              "terry",
              "mcp"
            ],
            "enabled": true,
            "environment": {
              "DAEMON_TOKEN": "test-token"
            }
          }
        },
        "provider": {
          "terry": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Terragon",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/openrouter/v1",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "glm-5.1": {
                "id": "z-ai/glm-5.1",
                "name": "GLM 5.1"
              },
              "kimi-k2.5": {
                "id": "moonshotai/kimi-k2.5",
                "name": "Kimi K2.5"
              },
              "grok-code": {
                "id": "x-ai/grok-code-fast-1",
                "name": "Grok Code Fast 1"
              },
              "qwen3-coder": {
                "id": "qwen/qwen3-coder:exacto",
                "name": "Qwen3 Coder 480B"
              },
              "gemini-2.5-pro": {
                "id": "google/gemini-2.5-pro",
                "name": "Gemini 2.5 Pro"
              },
              "gemini-3-pro": {
                "id": "google/gemini-3-pro-preview",
                "name": "Gemini 3 Pro"
              }
            }
          },
          "terry-google": {
            "npm": "@ai-sdk/google",
            "name": "Terragon Google",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/google/v1",
              "apiKey": "unused",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "gemini-2.5-pro": {
                "id": "gemini-2.5-pro",
                "name": "Gemini 2.5 Pro"
              },
              "gemini-3-pro": {
                "id": "gemini-3-pro-preview",
                "name": "Gemini 3 Pro"
              }
            }
          },
          "terry-ant": {
            "npm": "@ai-sdk/anthropic",
            "name": "Terragon Anthropic",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/anthropic/v1",
              "apiKey": "unused",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "sonnet": {
                "id": "claude-sonnet-4-5",
                "name": "Claude Sonnet 4.5"
              }
            }
          },
          "terry-oai": {
            "npm": "@ai-sdk/openai",
            "name": "Terragon OpenAI",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/openai/v1",
              "apiKey": "unused",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "gpt-5": {
                "id": "gpt-5",
                "name": "GPT-5"
              },
              "gpt-5-codex": {
                "id": "gpt-5-codex",
                "name": "GPT-5-Codex"
              }
            }
          }
        }
      }"
    `);
  });
});

describe("opencode model validation", () => {
  const OPENCODE_MODELS = agentToModels("opencode", {
    agentVersion: "latest",
    enableOpenRouterOpenAIAnthropicModel: true,
    enableOpencodeGemini3ProModelOption: true,
  });
  const OPENROUTER_MODELS = OPENCODE_MODELS.filter((model) =>
    model.startsWith("opencode/"),
  );

  it.each(OPENROUTER_MODELS)("should support %s", (model) => {
    const modelId = getModelId(model);
    expect(modelId).toBeDefined();
    expect(
      validateProviderModel({ provider: "openrouter", model: modelId }),
    ).toEqual({ valid: true });
  });
});
