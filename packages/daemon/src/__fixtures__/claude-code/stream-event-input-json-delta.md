# Claude Code fixture: stream-event-input-json-delta — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `stream_event` with content_block_delta input_json_delta

## Fields

- `type`: "stream_event" — streaming event wrapper
- `event.type`: "content_block_delta" — delta update for message content
- `event.index`: Block index within the message content array
- `event.delta.type`: "input_json_delta" — streaming JSON input update for tool_use
- `event.delta.partial_json`: Partial JSON string representing the tool input being built

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract events with `event.type: "content_block_delta"` and `delta.type: "input_json_delta"`
3. These events allow streaming updates to tool input parameters before the tool_use is complete
