# ACP fixture: diff — SYNTHESIZED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_message_chunk"` and diff content block
- Status: SYNTHESIZED (not captured from live sandbox; sandbox-agent does not emit diff blocks during typical runs)

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_message_chunk" — message streaming discriminant
- `params.update.content.type`: "diff" — content block type for code diffs
- `params.update.content.path`: File path being modified
- `params.update.content.oldContent` (optional): Original file content before changes
- `params.update.content.newContent`: Modified file content after changes
- `params.update.content.unifiedDiff` (optional): Unified diff format representation (standard patch format)
- `params.update.content.status`: Diff status (one of: pending, applied, rejected)

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that modifies files or produces code changes
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_message_chunk"` with content type "diff"
4. Note: Current sandbox-agent may not emit diff blocks; verify capability before capture attempt
