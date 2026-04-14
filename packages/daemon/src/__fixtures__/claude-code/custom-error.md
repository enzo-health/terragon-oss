# Claude Code fixture: custom-error — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `custom-error` message emitted during execution failure

## Fields

- `type`: "custom-error" — error message classification
- `session_id`: null (error occurred outside a valid session)
- `duration_ms`: Time elapsed before error (milliseconds)
- `error_info`: Error message describing what went wrong

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Trigger a task that fails (file not found, permission denied, etc.)
3. Extract the `custom-error` message that is emitted when an error occurs
