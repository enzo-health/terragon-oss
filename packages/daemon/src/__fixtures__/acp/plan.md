# ACP fixture: plan — CAPTURED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "plan"` for structured task planning

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "plan" — discriminant for plan/roadmap update
- `params.update.entries`: Array of plan items/tasks to execute
  - `priority`: Task priority level (one of: high, medium, low)
  - `status`: Task status (one of: pending, in_progress, completed)
  - `content`: Human-readable description of the task

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a complex multi-step task that generates a plan
3. Extract lines from the debug dump matching `"sessionUpdate":"plan"` with entries array
