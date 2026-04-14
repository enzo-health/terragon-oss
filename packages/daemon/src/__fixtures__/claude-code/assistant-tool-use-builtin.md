# Claude Code fixture: assistant-tool-use-builtin — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `assistant` message with built-in tool_use content

## Fields

- `type`: "assistant" — message role classification
- `session_id`: Session identifier (UUID format)
- `parent_tool_use_id`: null (top-level tool invocation)
- `message.role`: "assistant" — Anthropic SDK message role
- `message.content`: Array of content blocks
  - `type`: "tool_use" — tool invocation content block
  - `id`: Tool use identifier (unique for this invocation)
  - `name`: Built-in tool name (bash, read_file, write_file, edit_file, etc.)
  - `input`: Tool input parameters
    - `command`: Command or parameters for the tool
    - `description`: Optional description of why the tool is being called

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract messages with `type: "assistant"` and tool_use blocks
3. Built-in tools have simple names like "bash", "read_file", etc. (not "mcp\_\_...")
