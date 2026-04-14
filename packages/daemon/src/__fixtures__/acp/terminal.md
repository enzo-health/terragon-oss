# ACP fixture: terminal — SYNTHESIZED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_message_chunk"` and terminal content block
- Status: SYNTHESIZED (not captured from live sandbox; sandbox-agent does not emit terminal blocks during typical runs)

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_message_chunk" — message streaming discriminant
- `params.update.content.type`: "terminal" — content block type for terminal/shell output
- `params.update.content.terminalId`: Unique identifier for the terminal session
- `params.update.content.chunks`: Array of terminal output chunks
  - `streamSeq`: Sequence number for ordering chunks
  - `kind`: Output stream type (one of: stdout, stderr, interaction)
  - `text`: Terminal output text

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that executes shell commands or produces terminal output
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_message_chunk"` with content type "terminal"
4. Note: Current sandbox-agent may not emit terminal blocks; verify capability before capture attempt
