# Codex fixture: collab-agent-tool-call-completed — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Field shape matches expected `item/completed` notification with `itemType=collabAgentToolCall` per plan design.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/completed" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier within thread
- `params.item.id`: Unique identifier for this collaboration agent tool call
- `params.item.type`: "collabAgentToolCall" — identifies sub-agent delegation item
- `params.item.senderThreadId`: Thread ID of agent that initiated the delegation
- `params.item.receiverThreadIds[]`: Thread IDs of agents that participated
- `params.item.prompt`: User-facing description of delegated work
- `params.item.model`: Claude model identifier used
- `params.item.reasoningEffort`: Reasoning budget applied ("low" | "medium" | "high")
- `params.item.agentsStates`: Record mapping receiver thread IDs to final state (all "completed" in this fixture)
- `params.item.tool`: Collaboration tool type used ("message" indicates data exchange)
- `params.item.status`: "completed" — item lifecycle terminal state

## How to re-capture live

1. Invoke Codex with a delegation-eligible prompt
2. Allow delegation to run to completion
3. Capture the `item/completed` notification with `type: "collabAgentToolCall"`
4. Verify all `agentsStates` entries are "completed" or "failed" (terminal states)
