# Claude Code fixture: user-tool-result — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `user` message with tool_result content

## Fields

- `type`: "user" — message role classification
- `session_id`: Session identifier (UUID format)
- `parent_tool_use_id`: Tool use identifier this result responds to
- `message.role`: "user" — Anthropic SDK message role
- `message.content`: Array of content blocks
  - `type`: "tool_result" — tool execution result content block
  - `tool_use_id`: References the original tool_use id from the assistant message
  - `content`: String output/result from the tool execution

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract messages with `type: "user"` and tool_result content blocks
3. The tool_use_id should match a preceding assistant message's tool_use id
