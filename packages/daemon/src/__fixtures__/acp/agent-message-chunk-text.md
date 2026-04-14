# ACP fixture: agent-message-chunk-text — CAPTURED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_message_chunk"` and text content block

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_message_chunk" — discriminant for agent message text streaming
- `params.update.content.type`: "text" — content block type
- `params.update.content.text`: Message text chunk to append to the agent response

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a coding task that produces multiple agent reasoning turns
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_message_chunk"` with non-empty text content
