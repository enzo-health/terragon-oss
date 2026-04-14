# Codex fixture: item-reasoning-summary-part-added — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/reasoning/summaryPartAdded` notification for discrete summary components.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/reasoning/summaryPartAdded" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the reasoning item
- `params.summaryPart`: Summary component object
  - `summaryPart.id`: Unique identifier for this summary part
  - `summaryPart.type`: Part type identifier (e.g., "text")
  - `summaryPart.content`: Summary text content

## How to re-capture live

1. Send a prompt to Codex with extended thinking enabled
2. Observe Codex app-server output as reasoning completes
3. Capture `item/reasoning/summaryPartAdded` notifications
4. Verify `summaryPart` contains structured summary components
