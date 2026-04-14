# Claude Code fixture: assistant-tool-use-mcp — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `assistant` message with MCP tool_use content

## Fields

- `type`: "assistant" — message role classification
- `session_id`: Session identifier (UUID format)
- `parent_tool_use_id`: null (top-level tool invocation)
- `message.role`: "assistant" — Anthropic SDK message role
- `message.content`: Array of content blocks
  - `type`: "tool_use" — tool invocation content block
  - `id`: Tool use identifier (unique for this invocation)
  - `name`: MCP tool name with format "mcp**<server>**<tool>" (e.g., "mcp**github**search_repos")
  - `input`: Tool input parameters (schema varies by server and tool)

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract messages with `type: "assistant"` and tool_use blocks
3. MCP tools have names following the pattern "mcp**<server>**<toolname>"
4. The input object varies depending on the specific MCP server and tool
