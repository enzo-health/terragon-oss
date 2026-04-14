# Codex fixture: turn-diff-updated — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `turn/diff/updated` notification sent by Codex when a turn's unified diff is ready or updated.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "turn/diff/updated" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.diff`: Unified diff string (unified diff format with `---`, `+++`, `@@` headers and +/- lines)

## How to re-capture live

1. Send a prompt to Codex requesting file modifications (e.g., "Update the authentication middleware to accept nullable secret")
2. Wait for Codex to complete analysis
3. Capture the `turn/diff/updated` notification
4. Verify `diff` contains valid unified diff syntax with file paths and hunk markers
