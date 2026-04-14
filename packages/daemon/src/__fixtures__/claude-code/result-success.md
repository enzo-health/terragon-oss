# Claude Code fixture: result-success — CAPTURED

## Source

- Upstream ref: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Type definition: Claude Code stream-json terminal `result` message with subtype "success"

## Fields

- `type`: "result" — terminal message classification
- `subtype`: "success" — execution completed successfully
- `total_cost_usd`: API usage cost in USD
- `duration_ms`: Total execution time in milliseconds
- `duration_api_ms`: API request time in milliseconds
- `is_error`: false — no errors occurred
- `num_turns`: Number of agent turns/iterations completed
- `result`: Summary description of the execution result
- `session_id`: Session identifier (UUID format)

## How to re-capture live

1. Run Claude Code with `--output-format stream-json --include-partial-messages`
2. The last message should be a result message
3. For successful executions, extract the result message with `subtype: "success"`
