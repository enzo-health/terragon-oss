# ACP fixture: tool-call-update-in-progress — CAPTURED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "tool_call_update"` and status "in_progress"

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "tool_call_update" — discriminant for tool call progress update
- `params.update.toolCallId`: Reference to the tool call being updated
- `params.update.status`: "in_progress" — tool is currently executing
- `params.update.content.type`: "text" — output/progress content block type
- `params.update.content.text`: Output or progress text from the tool execution

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task with file operations or command execution
3. Extract lines from the debug dump matching `"sessionUpdate":"tool_call_update"` with status "in_progress"
