# Codex fixture: item-agent-message-delta — CAPTURED

## Source

Extracted from existing streaming paths. Represents well-known `item/agentMessage/delta` notification that daemon's PR #126 already handles via `extractThreadEventFromMethod()` synthesizing an `item.updated` ThreadEvent.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/agentMessage/delta" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the agent message being streamed
- `params.delta`: Text chunk to append to the message

## Notes

This is a baseline fixture for regression testing. It represents the streaming delta path that PR #126 optimized. The daemon synthesizes an `item.updated` ThreadEvent internally.
