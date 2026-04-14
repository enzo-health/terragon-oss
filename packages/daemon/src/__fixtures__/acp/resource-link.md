# ACP fixture: resource-link — SYNTHESIZED

## Source

- Upstream ref: https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- Type definition: Agent Client Protocol `session/update` with `sessionUpdate: "agent_message_chunk"` and resource_link content block
- Status: SYNTHESIZED (not captured from live sandbox; sandbox-agent does not emit resource links during typical runs)

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "session/update" — notification type
- `params.sessionId`: Session identifier (UUID format)
- `params.update.sessionUpdate`: "agent_message_chunk" — message streaming discriminant
- `params.update.content.type`: "resource_link" — content block type for external resource references
- `params.update.content.uri`: URL or URI to the resource
- `params.update.content.name`: Short identifier/name for the resource
- `params.update.content.title` (optional): Human-readable title of the resource
- `params.update.content.description` (optional): Detailed description of the resource
- `params.update.content.mimeType` (optional): MIME type of the resource
- `params.update.content.size` (optional): Size in bytes of the resource

## How to re-capture live

1. Run Claude Code (ACP transport) in a Terragon sandbox with `DEBUG_DUMP_NOTIFICATIONS` enabled
2. Trigger a task that references external documentation or resources
3. Extract lines from the debug dump matching `"sessionUpdate":"agent_message_chunk"` with content type "resource_link"
4. Note: Current sandbox-agent may not emit resource links; verify capability before capture attempt
