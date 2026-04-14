# Codex fixture: turn-started — CAPTURED

## Source

Extracted from METHOD_TO_THREAD_EVENT_TYPE mapping in `codex-app-server.ts`. Represents well-known `turn/started` notification that daemon already handles.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "turn/started" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)

## Notes

This is a baseline fixture for regression testing. It represents a simple turn lifecycle event that the daemon's `extractThreadEventFromMethod()` already handles by returning `{ type: "turn.started" }` with no additional fields required.
