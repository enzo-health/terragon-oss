# Codex fixture: item-file-change-output-delta — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/fileChange/outputDelta` notification for incremental file patch updates.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/fileChange/outputDelta" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the file change item
- `params.delta`: Unified diff string chunk (part of or complete file patch)

## How to re-capture live

1. Send a prompt requesting file modifications
2. Observe Codex app-server output as it generates patches
3. Capture `item/fileChange/outputDelta` notifications as diffs stream
4. Verify `delta` contains valid unified diff syntax or diff-adjacent content
