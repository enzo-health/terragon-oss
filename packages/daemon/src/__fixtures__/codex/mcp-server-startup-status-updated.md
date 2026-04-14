# Codex fixture: mcp-server-startup-status-updated — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `mcpServer/startupStatus/updated` notification for MCP server lifecycle events.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "mcpServer/startupStatus/updated" — notification method type
- `params.serverName`: Name of the MCP server (e.g., "github-integration")
- `params.status`: Server status ("loading" | "ready" | "error")
- `params.error`: Optional error message (string or null)

## How to re-capture live

1. Trigger Codex initialization requiring MCP servers
2. Observe Codex app-server output as servers initialize
3. Capture `mcpServer/startupStatus/updated` notifications for each server
4. Verify `status` progresses from "loading" to "ready" or "error"
