# Codex fixture: item-started-agent-message — CAPTURED

## Source

Extracted from existing test fixtures in `codex-app-server.test.ts` (APP_SERVER_ITEM_COMPLETED_TRANSCRIPT variant). Represents well-known `item/started` notification with `itemType=agentMessage` that daemon already handles.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/started" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.item.id`: Message item identifier
- `params.item.type`: "agentMessage" — identifies agent-generated text
- `params.item.text`: Initial message text (empty at start, filled by deltas)

## Notes

This is a baseline fixture for regression testing. It represents an existing code path the daemon already handles via `normalizeThreadItem()`.
