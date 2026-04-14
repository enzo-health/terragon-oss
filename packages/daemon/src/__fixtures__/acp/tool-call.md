# ACP fixture: tool-call — CAPTURED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "tool_call"` for tool invocation lifecycle start

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "tool_call" — discriminant for tool call start event
- `params.update.toolCallId`: Unique identifier for this tool invocation
- `params.update.title`: Human-readable description of the tool call
- `params.update.kind`: Tool type (one of: read, edit, delete, search, execute, think, fetch, other)
- `params.update.status`: "pending" — initial status before execution
- `params.update.locations`: Array of file/location references the tool operates on
- `params.update.rawInput`: Raw user input or prompt that triggered the tool call

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that performs file operations (read, edit, search, execute commands)
3. Extract lines from the debug dump matching `"sessionUpdate":"tool_call"` with status "pending"
