import { describe, it, expect } from "vitest";
import { parse as tomlParse } from "@iarna/toml";
import { buildCodexToml } from "./codex-config";
import type { McpConfig } from "../mcp-config";

describe("buildCodexToml", () => {
  it("emits toml with mcp_servers using unified merge logic and filters out SSE/HTTP servers", () => {
    const userCfg: McpConfig = {
      mcpServers: {
        // command-based
        alpha: { command: "npx", args: ["-y", "alpha"], env: { API_KEY: "a" } },
        // sse-based (should be filtered out)
        stream: {
          type: "sse",
          url: "https://s.example.com/stream",
          headers: { Auth: "tok" },
        },
        // http-based (should be filtered out)
        api: {
          type: "http",
          url: "https://api.example.com",
          headers: { Authorization: "Bearer token" },
        },
        // user-provided terry (should be ignored)
        terry: { command: "node", args: ["/not/used.mjs"] },
      },
    };

    const toml = buildCodexToml({
      userMcpConfig: userCfg,
      includeTerry: true,
      terryCommand: "node",
      terryArgs: ["/tmp/terry-mcp-server.mjs"],
      terryModelProviderBaseUrl: "https://example.com/api/proxy/openai/v1",
    });
    expect(toml).toMatchInlineSnapshot(`
      "# IMPORTANT: the top-level key is \`mcp_servers\` rather than \`mcpServers\`.
      [model_providers.terry]
      name = "terry"
      base_url = "https://example.com/api/proxy/openai/v1"
      wire_api = "responses"

        [model_providers.terry.env_http_headers]
        X-Daemon-Token = "DAEMON_TOKEN"

      [mcp_servers.alpha]
      command = "npx"
      args = [ "-y", "alpha" ]
      startup_timeout_ms = 20_000

        [mcp_servers.alpha.env]
        API_KEY = "a"

      [mcp_servers.terry]
      command = "node"
      args = [ "/tmp/terry-mcp-server.mjs" ]
      startup_timeout_ms = 20_000

      [shell_environment_policy]
      inherit = "all"
      ignore_default_excludes = true

      [tools]
      web_search = true
      "
    `);

    const parsed = tomlParse(toml) as any;
    expect(parsed.model_providers.terry).toEqual({
      name: "terry",
      base_url: "https://example.com/api/proxy/openai/v1",
      env_http_headers: { "X-Daemon-Token": "DAEMON_TOKEN" },
      wire_api: "responses",
    });
    expect(parsed).toHaveProperty("mcp_servers");
    expect(parsed.mcp_servers.alpha).toEqual({
      command: "npx",
      args: ["-y", "alpha"],
      env: { API_KEY: "a" },
      startup_timeout_ms: 20_000,
    });

    // SSE and HTTP servers should be filtered out
    expect(parsed.mcp_servers.stream).toBeUndefined();
    expect(parsed.mcp_servers.api).toBeUndefined();

    // built-in terry present and normalized
    expect(parsed.mcp_servers.terry).toEqual({
      command: "node",
      args: ["/tmp/terry-mcp-server.mjs"],
      startup_timeout_ms: 20_000,
    });

    // shell environment policy should be present
    expect(parsed.shell_environment_policy).toEqual({
      inherit: "all",
      ignore_default_excludes: true,
    });

    expect(parsed.tools).toEqual({ web_search: true });
  });

  it("handles multiple servers with env variables as inline tables", () => {
    const userCfg: McpConfig = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["server1.js"],
          env: { API_KEY: "key1", BASE_URL: "https://api1.example.com" },
        },
        server2: {
          command: "python",
          args: ["-m", "server2"],
          env: { TOKEN: "secret_token", DEBUG: "true" },
        },
        server3: {
          command: "deno",
          args: ["run", "server3.ts"],
          // No env for this one
        },
        server4: {
          command: "bun",
          env: { NODE_ENV: "production" }, // env but no args
        },
      },
    };

    const toml = buildCodexToml({
      userMcpConfig: userCfg,
      includeTerry: false,
      terryCommand: "node",
      terryArgs: ["/tmp/terry-mcp-server.mjs"],
      terryModelProviderBaseUrl: "https://example.com/api/proxy/openai/v1",
    });

    expect(toml).toMatchInlineSnapshot(`
      "# IMPORTANT: the top-level key is \`mcp_servers\` rather than \`mcpServers\`.
      [model_providers.terry]
      name = "terry"
      base_url = "https://example.com/api/proxy/openai/v1"
      wire_api = "responses"

        [model_providers.terry.env_http_headers]
        X-Daemon-Token = "DAEMON_TOKEN"

      [mcp_servers.server1]
      command = "node"
      args = [ "server1.js" ]
      startup_timeout_ms = 20_000

        [mcp_servers.server1.env]
        API_KEY = "key1"
        BASE_URL = "https://api1.example.com"

      [mcp_servers.server2]
      command = "python"
      args = [ "-m", "server2" ]
      startup_timeout_ms = 20_000

        [mcp_servers.server2.env]
        TOKEN = "secret_token"
        DEBUG = "true"

      [mcp_servers.server3]
      command = "deno"
      args = [ "run", "server3.ts" ]
      startup_timeout_ms = 20_000

      [mcp_servers.server4]
      command = "bun"
      startup_timeout_ms = 20_000

        [mcp_servers.server4.env]
        NODE_ENV = "production"

      [shell_environment_policy]
      inherit = "all"
      ignore_default_excludes = true

      [tools]
      web_search = true
      "
    `);

    const parsed = tomlParse(toml) as any;

    expect(parsed.model_providers.terry).toEqual({
      name: "terry",
      base_url: "https://example.com/api/proxy/openai/v1",
      wire_api: "responses",
      env_http_headers: { "X-Daemon-Token": "DAEMON_TOKEN" },
    });

    // Verify all servers are parsed correctly with inline env tables
    expect(parsed.mcp_servers.server1).toEqual({
      command: "node",
      args: ["server1.js"],
      env: { API_KEY: "key1", BASE_URL: "https://api1.example.com" },
      startup_timeout_ms: 20_000,
    });

    expect(parsed.mcp_servers.server2).toEqual({
      command: "python",
      args: ["-m", "server2"],
      env: { TOKEN: "secret_token", DEBUG: "true" },
      startup_timeout_ms: 20_000,
    });

    expect(parsed.mcp_servers.server3).toEqual({
      command: "deno",
      args: ["run", "server3.ts"],
      startup_timeout_ms: 20_000,
    });

    expect(parsed.mcp_servers.server4).toEqual({
      command: "bun",
      env: { NODE_ENV: "production" },
      startup_timeout_ms: 20_000,
    });

    expect(parsed.tools).toEqual({ web_search: true });
  });

  it("handles special characters in env values correctly", () => {
    const userCfg: McpConfig = {
      mcpServers: {
        specialChars: {
          command: "node",
          args: ["test.js"],
          env: {
            SIMPLE: "value",
            WITH_QUOTES: 'value with "quotes"',
            WITH_SINGLE_QUOTES: "value with 'quotes'",
            WITH_BACKSLASH: "path\\to\\file",
            WITH_NEWLINE: "line1\nline2",
            WITH_TAB: "col1\tcol2",
            WITH_UNICODE: "Hello 世界 🌍",
            WITH_EQUALS: "key=value",
            WITH_BRACES: "{json: true}",
            WITH_BRACKETS: "[array, items]",
            EMPTY: "",
            WITH_SPACES: "  spaced value  ",
            WITH_SPECIAL_COMBO: `{"key": "value with 'quotes' and \\"escapes\\""}`,
          },
        },
      },
    };

    const toml = buildCodexToml({
      userMcpConfig: userCfg,
      includeTerry: false,
      terryCommand: "node",
      terryArgs: ["/tmp/terry-mcp-server.mjs"],
      terryModelProviderBaseUrl: "https://example.com/api/proxy/openai/v1",
    });

    // Check that the TOML was generated
    expect(toml).toMatchInlineSnapshot(`
      "# IMPORTANT: the top-level key is \`mcp_servers\` rather than \`mcpServers\`.
      [model_providers.terry]
      name = "terry"
      base_url = "https://example.com/api/proxy/openai/v1"
      wire_api = "responses"

        [model_providers.terry.env_http_headers]
        X-Daemon-Token = "DAEMON_TOKEN"

      [mcp_servers.specialChars]
      command = "node"
      args = [ "test.js" ]
      startup_timeout_ms = 20_000

        [mcp_servers.specialChars.env]
        SIMPLE = "value"
        WITH_QUOTES = 'value with "quotes"'
        WITH_SINGLE_QUOTES = "value with 'quotes'"
        WITH_BACKSLASH = "path\\\\to\\\\file"
        WITH_NEWLINE = """
      line1
      line2"""
        WITH_TAB = "col1\\tcol2"
        WITH_UNICODE = "Hello 世界 🌍"
        WITH_EQUALS = "key=value"
        WITH_BRACES = "{json: true}"
        WITH_BRACKETS = "[array, items]"
        EMPTY = ""
        WITH_SPACES = "  spaced value  "
        WITH_SPECIAL_COMBO = "{\\"key\\": \\"value with 'quotes' and \\\\\\"escapes\\\\\\"\\"}"

      [shell_environment_policy]
      inherit = "all"
      ignore_default_excludes = true

      [tools]
      web_search = true
      "
    `);

    // Parse it back to verify it's valid TOML
    let parsed: any;
    expect(() => {
      parsed = tomlParse(toml);
    }).not.toThrow();

    // Verify the values were preserved correctly
    expect(parsed.model_providers.terry).toEqual({
      name: "terry",
      base_url: "https://example.com/api/proxy/openai/v1",
      wire_api: "responses",
      env_http_headers: { "X-Daemon-Token": "DAEMON_TOKEN" },
    });

    expect(parsed.mcp_servers.specialChars.env).toEqual({
      SIMPLE: "value",
      WITH_QUOTES: 'value with "quotes"',
      WITH_SINGLE_QUOTES: "value with 'quotes'",
      WITH_BACKSLASH: "path\\to\\file",
      WITH_NEWLINE: "line1\nline2",
      WITH_TAB: "col1\tcol2",
      WITH_UNICODE: "Hello 世界 🌍",
      WITH_EQUALS: "key=value",
      WITH_BRACES: "{json: true}",
      WITH_BRACKETS: "[array, items]",
      EMPTY: "",
      WITH_SPACES: "  spaced value  ",
      WITH_SPECIAL_COMBO: `{"key": "value with 'quotes' and \\"escapes\\""}`,
    });

    expect(parsed.tools).toEqual({ web_search: true });
  });
});
