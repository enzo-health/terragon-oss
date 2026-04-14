# Codex fixture: thread-token-usage-updated — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `thread/tokenUsage/updated` notification sent periodically to report cumulative token consumption.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "thread/tokenUsage/updated" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.usage.input_tokens`: Count of tokens consumed by input/prompts
- `params.usage.cached_input_tokens`: Count of input tokens served from cache (cache hits)
- `params.usage.output_tokens`: Count of tokens generated in responses

## How to re-capture live

1. Send a conversation to Codex and allow it to process
2. Observe Codex app-server output during and after processing
3. Capture the `thread/tokenUsage/updated` notification
4. Verify token counts are positive integers and cumulative (increase or stay same over time)
