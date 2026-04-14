# Claude Code fixture: assistant-thinking — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `assistant` message with thinking content

## Fields

- `type`: "assistant" — message role classification
- `session_id`: Session identifier (UUID format)
- `parent_tool_use_id`: null (internal reasoning, not a tool result)
- `message.role`: "assistant" — Anthropic SDK message role
- `message.content`: Array of content blocks
  - `type`: "thinking" — reasoning/thought content block
  - `thinking`: Internal reasoning text

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract messages with `type: "assistant"` and thinking content blocks
3. Thinking blocks represent Claude's internal reasoning before tool calls or responses
