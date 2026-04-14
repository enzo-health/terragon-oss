# ACP fixture: request-permission — CAPTURED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/request_permission` JSON-RPC method (not a sessionUpdate)

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/request_permission" — method name for permission request notification
- `params.sessionId`: Session identifier (UUID format)
- `params.toolCall`: Tool call information that requires permission
  - `toolCallId`: Unique identifier for the tool invocation
  - `title`: Human-readable description of the action
  - `kind`: Tool type (one of: read, edit, delete, search, execute, think, fetch, other)
  - `locations`: File/location references the tool operates on
  - `rawInput`: Raw command or input provided
- `params.options`: Array of permission options to present to the user
  - `optionId`: Unique identifier for this permission option
  - `text`: Human-readable text describing the option

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that requires user permission (execute commands, delete files, etc.)
3. Extract lines from the debug dump matching `"method":"session/request_permission"`
4. Capture before user approves/denies to get the pristine permission request
