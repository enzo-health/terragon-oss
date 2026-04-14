# ACP fixture: audio — SYNTHESIZED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_message_chunk"` and audio content block
- Status: SYNTHESIZED (not captured from live sandbox; sandbox-agent does not emit audio during typical runs)

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_message_chunk" — message streaming discriminant
- `params.update.content.type`: "audio" — content block type for audio media
- `params.update.content.mimeType`: MIME type of the audio (e.g., "audio/wav", "audio/mp3", "audio/ogg")
- `params.update.content.data`: Base64-encoded audio data (or URI reference in some variants)

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that produces audio output or narration
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_message_chunk"` with content type "audio"
4. Note: Current sandbox-agent may not emit audio blocks; verify capability before capture attempt
