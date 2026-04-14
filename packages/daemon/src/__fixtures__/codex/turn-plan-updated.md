# Codex fixture: turn-plan-updated — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `turn/plan/updated` notification sent when Codex updates its breakdown of planned steps.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "turn/plan/updated" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.plan.entries[]`: Array of plan step objects
  - `entries[].id`: Unique identifier for this step
  - `entries[].content`: Human-readable description of the step
  - `entries[].status`: Step status ("pending" | "in_progress" | "completed" | "failed")

## How to re-capture live

1. Send a multi-step task prompt to Codex (e.g., "Analyze this code, propose refactoring, then implement the changes")
2. Observe Codex app-server output as planning progresses
3. Capture the `turn/plan/updated` notification
4. Verify `plan.entries` contains steps with distinct statuses reflecting execution progress
