# Codex fixture: item-reasoning-summary-text-delta — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/reasoning/summaryTextDelta` notification for streaming human-readable summaries of reasoning.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/reasoning/summaryTextDelta" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the reasoning item
- `params.delta`: Text chunk of the reasoning summary (accumulated via deltas)

## How to re-capture live

1. Send a prompt to Codex with extended thinking enabled
2. Observe Codex app-server output during reasoning
3. Capture `item/reasoning/summaryTextDelta` notifications as summary streams
4. Verify `delta` contains meaningful reasoning summary text
