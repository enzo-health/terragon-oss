# Codex fixture: item-command-execution-output-delta — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/commandExecution/outputDelta` notification for streaming command output.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/commandExecution/outputDelta" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the command execution item being updated
- `params.output`: Text chunk of command output (can contain newlines, ANSI codes)

## How to re-capture live

1. Send a prompt requesting command execution (e.g., "Run npm test")
2. Observe Codex app-server output as the command executes
3. Capture `item/commandExecution/outputDelta` notifications as output streams
4. Verify `output` contains a realistic command output snippet
