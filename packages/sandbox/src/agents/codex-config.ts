import { McpConfig } from "../mcp-config";
import { stringify as tomlStringify } from "@iarna/toml";
import { buildMergedMcpConfig } from "../utils/mcp-merge";

export function buildCodexToml({
  userMcpConfig,
  includeTerry,
  terryCommand,
  terryArgs,
  terryModelProviderBaseUrl,
}: {
  userMcpConfig: McpConfig | undefined;
  includeTerry: boolean;
  terryCommand: string;
  terryArgs: string[];
  terryModelProviderBaseUrl?: string | null;
}): string {
  const merged: McpConfig = buildMergedMcpConfig({
    userMcpConfig,
    includeTerry,
    terryCommand,
    terryArgs,
  });

  // Map JSON schema to Codex TOML layout
  const mcpServersToml: Record<string, any> = {};
  for (const [name, server] of Object.entries(merged.mcpServers)) {
    // Only include command-based servers, filter out SSE and HTTP servers
    if ("command" in server) {
      mcpServersToml[name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        startup_timeout_ms: 20_000,
      };
    }
    // Skip SSE and HTTP servers by not including the else branch
  }

  const modelProvidersToml: Record<string, any> = {};

  // Increase timeouts for the built-in openai provider to handle long-running tasks.
  // Must be under [model_providers.openai] — root-level keys are silently ignored by codex_core.
  // Note: request_max_retries cannot be overridden for built-in openai provider (Codex #3026).
  modelProvidersToml.openai = {
    stream_idle_timeout_ms: 600_000,
    stream_max_retries: 20,
  };

  if (terryModelProviderBaseUrl) {
    modelProvidersToml.terry = {
      name: "terry",
      base_url: terryModelProviderBaseUrl,
      env_http_headers: {
        "X-Daemon-Token": "DAEMON_TOKEN",
      },
      wire_api: "responses",
    };
  }

  const obj: Record<string, any> = {};
  if (Object.keys(modelProvidersToml).length > 0) {
    obj.model_providers = modelProvidersToml;
  }

  obj.mcp_servers = mcpServersToml;
  obj.shell_environment_policy = {
    inherit: "all",
    ignore_default_excludes: true,
  };
  obj.tools = {
    web_search: true,
  };
  const header =
    "# IMPORTANT: the top-level key is `mcp_servers` rather than `mcpServers`.\n";
  return header + tomlStringify(obj);
}
