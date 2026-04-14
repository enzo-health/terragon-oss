# Claude Code fixture: system-init — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `system` message with subtype "init"

## Fields

- `type`: "system" — message classification
- `subtype`: "init" — system initialization message
- `session_id`: Session identifier (UUID format)
- `tools`: Array of available tool names (built-in tools like bash, read_file, write_file, etc.)
- `mcp_servers`: Array of MCP server availability status
  - `name`: Server identifier
  - `status`: Server health status (healthy, degraded, unhealthy, etc.)

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. The first message in the output stream should be the system init message
3. Extract the JSON object with `type: "system"` and `subtype: "init"`
