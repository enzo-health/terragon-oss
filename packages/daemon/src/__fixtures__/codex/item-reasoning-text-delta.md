# Codex fixture: item-reasoning-text-delta — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/reasoning/textDelta` notification for streaming raw thinking/internal reasoning.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/reasoning/textDelta" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the reasoning item
- `params.delta`: Text chunk of raw thinking (accumulated via deltas)

## How to re-capture live

1. Send a prompt to Codex with extended thinking enabled
2. Observe Codex app-server output during internal reasoning
3. Capture `item/reasoning/textDelta` notifications as raw thinking streams
4. Verify `delta` contains unfiltered internal reasoning text
