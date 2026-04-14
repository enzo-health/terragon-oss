# Claude Code fixture: stream-event-text-delta — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `stream_event` with content_block_delta text_delta

## Fields

- `type`: "stream_event" — streaming event wrapper
- `event.type`: "content_block_delta" — delta update for message content
- `event.index`: Block index within the message content array
- `event.delta.type`: "text_delta" — streaming text content update
- `event.delta.text`: Text chunk to append to the message

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Extract events with `event.type: "content_block_delta"` and `delta.type: "text_delta"`
3. These events arrive before the complete message, enabling live streaming UI updates
