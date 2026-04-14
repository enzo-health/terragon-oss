# Claude Code fixture: assistant-text — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `assistant` message with text content

## Fields

- `type`: "assistant" — message role classification
- `session_id`: Session identifier (UUID format)
- `parent_tool_use_id`: null (top-level message, not a tool result)
- `message.role`: "assistant" — Anthropic SDK message role
- `message.content`: Array of content blocks
  - `type`: "text" — content block type
  - `text`: Assistant response text

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract messages with `type: "assistant"` and `message.content` containing text blocks
3. The parent_tool_use_id will be null for top-level reasoning or responses
