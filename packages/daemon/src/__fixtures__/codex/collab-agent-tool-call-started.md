# Codex fixture: collab-agent-tool-call-started — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Field shape matches expected `item/started` notification with `itemType=collabAgentToolCall` per plan design.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/started" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier within thread
- `params.item.id`: Unique identifier for this collaboration agent tool call
- `params.item.type`: "collabAgentToolCall" — identifies sub-agent delegation item
- `params.item.senderThreadId`: Thread ID of agent initiating the delegation
- `params.item.receiverThreadIds[]`: Thread IDs of agents receiving the delegation
- `params.item.prompt`: User-facing prompt describing the delegated work
- `params.item.model`: Claude model identifier used for delegation
- `params.item.reasoningEffort`: Reasoning budget ("low" | "medium" | "high")
- `params.item.agentsStates`: Record mapping receiver thread IDs to state ("initiated" | "running" | "completed" | "failed")
- `params.item.tool`: Collaboration tool type ("spawn" | "message" | "kill")
- `params.item.status`: Item lifecycle status at event time ("initiated" | "running" | "completed" | "failed")

## How to re-capture live

1. Invoke Codex with a prompt that requests sub-agent delegation (e.g., "Please help me with task X" where Codex decides to spawn helper agents)
2. Observe Codex app-server output during delegation initialization
3. Capture the `item/started` notification with `type: "collabAgentToolCall"`
4. Verify `agentsStates` contains initial "initiated" statuses for all receiver threads
