# ACP fixture: image — SYNTHESIZED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_message_chunk"` and image content block
- Status: SYNTHESIZED (not captured from live sandbox; sandbox-agent does not emit images during typical runs)

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_message_chunk" — message streaming discriminant
- `params.update.content.type`: "image" — content block type for image media
- `params.update.content.mimeType`: MIME type of the image (e.g., "image/png", "image/jpeg")
- `params.update.content.data`: Base64-encoded image data (or URI reference in some variants)

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that produces visual diagrams or screenshots
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_message_chunk"` with content type "image"
4. Note: Current sandbox-agent may not emit image blocks; verify capability before capture attempt
