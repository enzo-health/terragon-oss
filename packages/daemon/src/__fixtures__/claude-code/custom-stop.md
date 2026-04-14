# Claude Code fixture: custom-stop — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json `custom-stop` message emitted when execution is interrupted or stopped

## Fields

- `type`: "custom-stop" — stop message classification
- `session_id`: null (session is terminating)
- `duration_ms`: Time elapsed before stop (milliseconds)

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. Send SIGINT or Ctrl+C to interrupt execution
3. Extract the `custom-stop` message that is emitted when the process terminates normally (without error)
