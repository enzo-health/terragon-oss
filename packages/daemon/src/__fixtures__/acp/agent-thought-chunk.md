# ACP fixture: agent-thought-chunk — CAPTURED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_thought_chunk"` for reasoning stream

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_thought_chunk" — discriminant for internal reasoning/thinking content
- `params.update.content.type`: "text" — content block type
- `params.update.content.text`: Reasoning text chunk to append to the agent's internal thought process

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a coding task with extended reasoning or plan generation
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_thought_chunk"` with non-empty text content
