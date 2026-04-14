# Codex fixture: item-mcp-tool-call-progress — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/mcpToolCall/progress` notification for long-running MCP (Model Context Protocol) tool calls.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/mcpToolCall/progress" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the MCP tool call item
- `params.status`: Current execution status ("in_progress" | "completed" | "failed")
- `params.progress`: Progress metadata object
  - `progress.currentStep`: Integer indicating current step number
  - `progress.totalSteps`: Integer indicating total steps expected
  - `progress.message`: Human-readable progress message
  - `progress.partialResult`: Optional intermediate result data (object)

## How to re-capture live

1. Send a prompt that triggers an MCP tool call with multi-step execution
2. Observe Codex app-server output during tool execution
3. Capture `item/mcpToolCall/progress` notifications as progress updates
4. Verify `progress` object contains step counts and partial results
