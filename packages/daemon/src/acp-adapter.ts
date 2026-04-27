import { ClaudeMessage } from "./shared";
import { recordUnknownEvent } from "./unknown-event-telemetry";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the adapter encounters a `sessionUpdate` discriminant it has no
 * handler for. Callers can catch this to decide whether to surface as an error
 * or silently drop the event.
 */
export class UnknownAcpContentTypeError extends Error {
  readonly sessionUpdate: string;
  constructor(sessionUpdate: string) {
    super(`Unknown ACP sessionUpdate type: ${sessionUpdate}`);
    this.name = "UnknownAcpContentTypeError";
    this.sessionUpdate = sessionUpdate;
  }
}

// ---------------------------------------------------------------------------
// Internal utility types
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

type JsonRpcEnvelope = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type AcpPermissionRequest = {
  acpRequestId: unknown;
  options: unknown[];
  description: string;
  toolName: string;
};

export type NormalizedAcpPermissionRequest = {
  request: AcpPermissionRequest;
  message: ClaudeMessage;
};

// ---------------------------------------------------------------------------
// Tool-call lifecycle tracker (Task 3.2)
// ---------------------------------------------------------------------------

export type AcpToolCallState = {
  toolCallId: string;
  title: string;
  kind:
    | "read"
    | "edit"
    | "delete"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "other";
  locations: Array<{ type: string; path: string; range: unknown | null }>;
  rawInput: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  rawOutput?: string;
  progressChunks: Array<{ seq: number; text: string }>;
};

/**
 * Stateful per-session tracker for ACP tool-call lifecycle events.
 * Keyed by toolCallId. Holds the accumulated state so that successive
 * tool_call_update events can enrich the original tool_call.
 */
export class AcpToolCallTracker {
  private states = new Map<string, AcpToolCallState>();

  /**
   * Process a `tool_call` initial event. Creates the tracker entry.
   */
  handleToolCall(update: JsonObject, sessionId: string): ClaudeMessage | null {
    const toolCallId = readString(update, "toolCallId");
    if (!toolCallId) return null;

    const title = readString(update, "title") ?? "";
    const kind = normalizeKind(readString(update, "kind"));
    const rawInput = readString(update, "rawInput") ?? "";
    const locations = readLocations(update.locations);
    const status = (readString(update, "status") ?? "pending") as
      | "pending"
      | "in_progress"
      | "completed"
      | "failed";

    const state: AcpToolCallState = {
      toolCallId,
      title,
      kind,
      locations,
      rawInput,
      status,
      startedAt: new Date().toISOString(),
      progressChunks: [],
    };

    this.states.set(toolCallId, state);

    return {
      type: "acp-tool-call",
      session_id: sessionId,
      toolCallId: state.toolCallId,
      title: state.title,
      kind: state.kind,
      status: state.status,
      locations: state.locations,
      rawInput: state.rawInput,
      startedAt: state.startedAt,
      progressChunks: [],
    };
  }

  /**
   * Process a `tool_call_update` event. Updates the tracker entry and emits a
   * new snapshot.
   */
  handleToolCallUpdate(
    update: JsonObject,
    sessionId: string,
  ): ClaudeMessage | null {
    const toolCallId = readString(update, "toolCallId");
    if (!toolCallId) return null;

    const state = this.states.get(toolCallId);
    if (!state) return null;

    const newStatus = (readString(update, "status") ??
      state.status) as AcpToolCallState["status"];
    const contentText = toTextContent(update.content);
    const rawOutput = readString(update, "rawOutput");

    if (contentText) {
      state.progressChunks.push({
        seq: state.progressChunks.length,
        text: contentText,
      });
    }

    state.status = newStatus;
    if (rawOutput !== null) {
      state.rawOutput = rawOutput;
    }
    if (newStatus === "completed" || newStatus === "failed") {
      state.completedAt = new Date().toISOString();
    }

    return {
      type: "acp-tool-call",
      session_id: sessionId,
      toolCallId: state.toolCallId,
      title: state.title,
      kind: state.kind,
      status: state.status,
      locations: state.locations,
      rawInput: state.rawInput,
      rawOutput: state.rawOutput,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      progressChunks: [...state.progressChunks],
    };
  }

  /** Access the accumulated state (for tests). */
  getState(toolCallId: string): AcpToolCallState | undefined {
    return this.states.get(toolCallId);
  }

  /** Clear all tracked state. */
  clear(): void {
    this.states.clear();
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function readString(obj: JsonObject, key: string): string | null {
  const val = obj[key];
  return typeof val === "string" ? val : null;
}

function normalizeKind(raw: string | null): AcpToolCallState["kind"] {
  const valid = new Set([
    "read",
    "edit",
    "delete",
    "search",
    "execute",
    "think",
    "fetch",
    "other",
  ] as const);
  if (raw && valid.has(raw as AcpToolCallState["kind"])) {
    return raw as AcpToolCallState["kind"];
  }
  return "other";
}

function readLocations(
  value: unknown,
): Array<{ type: string; path: string; range: unknown | null }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((loc) => {
      const obj = asObject(loc);
      if (!obj) return null;
      return {
        type: typeof obj.type === "string" ? obj.type : "file",
        path: typeof obj.path === "string" ? obj.path : "",
        range: obj.range ?? null,
      };
    })
    .filter(Boolean) as Array<{
    type: string;
    path: string;
    range: unknown | null;
  }>;
}

function toTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const itemObject = asObject(item);
        if (!itemObject) {
          return "";
        }
        // Try common content fields: text, diff, patch, data, content
        for (const field of ["text", "diff", "patch", "data", "content"]) {
          const val = itemObject[field];
          if (typeof val === "string") return val;
        }
        return "";
      })
      .join("\n");
  }
  const contentObject = asObject(content);
  if (!contentObject) {
    return "";
  }
  const text = contentObject.text;
  return typeof text === "string" ? text : "";
}

function getSessionId(_params: JsonObject, fallbackSessionId: string): string {
  return fallbackSessionId;
}

export function parseAcpPermissionRequest(
  payload: string,
): AcpPermissionRequest | null {
  let parsed: JsonRpcEnvelope | null = null;
  try {
    parsed = JSON.parse(payload) as JsonRpcEnvelope;
  } catch {
    return null;
  }
  const envelope = asObject(parsed);
  if (
    !envelope ||
    envelope.method !== "session/request_permission" ||
    envelope.id === undefined
  ) {
    return null;
  }
  const params = asObject(envelope.params);
  const toolCall = params ? asObject(params.toolCall) : null;
  const rawOptions = Array.isArray(params?.options) ? params.options : [];
  return {
    acpRequestId: envelope.id,
    options: rawOptions,
    description:
      typeof params?.description === "string"
        ? params.description
        : typeof toolCall?.title === "string"
          ? toolCall.title
          : typeof toolCall?.rawInput === "string"
            ? toolCall.rawInput
            : "",
    toolName:
      typeof params?.tool_name === "string"
        ? params.tool_name
        : typeof toolCall?.kind === "string"
          ? toolCall.kind
          : "",
  };
}

export function normalizeAcpPermissionRequest({
  payload,
  promptId,
  sessionId,
}: {
  payload: string;
  promptId: string;
  sessionId: string;
}): NormalizedAcpPermissionRequest | null {
  const request = parseAcpPermissionRequest(payload);
  if (!request) {
    return null;
  }
  return {
    request,
    message: createAcpPermissionRequestMessage({
      request,
      promptId,
      sessionId,
    }),
  };
}

export function createAcpPermissionRequestMessage({
  request,
  promptId,
  sessionId,
}: {
  request: AcpPermissionRequest;
  promptId: string;
  sessionId: string;
}): ClaudeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: promptId,
          name: "PermissionRequest",
          input: {
            options: request.options,
            description: request.description,
            tool_name: request.toolName,
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Content-block handlers (used inside the switch)
// ---------------------------------------------------------------------------

function handleAgentMessageContent(
  content: unknown,
  sessionId: string,
): ClaudeMessage[] {
  const contentObj = asObject(content);
  if (!contentObj) {
    // Fallback: plain string or array of strings → text
    const text = toTextContent(content);
    if (!text) return [];
    return [
      {
        type: "assistant",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    ];
  }

  const blockType = contentObj.type;

  // image
  if (blockType === "image") {
    return [
      {
        type: "acp-image",
        session_id: sessionId,
        mimeType:
          typeof contentObj.mimeType === "string" ? contentObj.mimeType : "",
        data: typeof contentObj.data === "string" ? contentObj.data : undefined,
        uri: typeof contentObj.uri === "string" ? contentObj.uri : undefined,
      },
    ];
  }

  // audio
  if (blockType === "audio") {
    return [
      {
        type: "acp-audio",
        session_id: sessionId,
        mimeType:
          typeof contentObj.mimeType === "string" ? contentObj.mimeType : "",
        data: typeof contentObj.data === "string" ? contentObj.data : undefined,
        uri: typeof contentObj.uri === "string" ? contentObj.uri : undefined,
      },
    ];
  }

  // resource_link
  if (blockType === "resource_link") {
    return [
      {
        type: "acp-resource-link",
        session_id: sessionId,
        uri: typeof contentObj.uri === "string" ? contentObj.uri : "",
        name: typeof contentObj.name === "string" ? contentObj.name : "",
        title:
          typeof contentObj.title === "string" ? contentObj.title : undefined,
        description:
          typeof contentObj.description === "string"
            ? contentObj.description
            : undefined,
        mimeType:
          typeof contentObj.mimeType === "string"
            ? contentObj.mimeType
            : undefined,
        size: typeof contentObj.size === "number" ? contentObj.size : undefined,
      },
    ];
  }

  // terminal
  if (blockType === "terminal") {
    const terminalId =
      typeof contentObj.terminalId === "string" ? contentObj.terminalId : "";
    const chunks = Array.isArray(contentObj.chunks)
      ? contentObj.chunks
          .map((ch) => {
            const chObj = asObject(ch);
            if (!chObj) return null;
            return {
              streamSeq:
                typeof chObj.streamSeq === "number" ? chObj.streamSeq : 0,
              kind:
                chObj.kind === "stdout" ||
                chObj.kind === "stderr" ||
                chObj.kind === "interaction"
                  ? (chObj.kind as "stdout" | "stderr" | "interaction")
                  : ("stdout" as const),
              text: typeof chObj.text === "string" ? chObj.text : "",
            };
          })
          .filter(Boolean)
      : [];
    return [
      {
        type: "acp-terminal",
        session_id: sessionId,
        terminalId,
        chunks: chunks as Array<{
          streamSeq: number;
          kind: "stdout" | "stderr" | "interaction";
          text: string;
        }>,
      },
    ];
  }

  // diff
  if (blockType === "diff") {
    const filePath =
      typeof contentObj.path === "string"
        ? contentObj.path
        : typeof contentObj.filePath === "string"
          ? contentObj.filePath
          : "";
    const rawStatus = contentObj.status;
    const status: "pending" | "applied" | "rejected" =
      rawStatus === "applied" || rawStatus === "rejected"
        ? rawStatus
        : "pending";
    return [
      {
        type: "acp-diff",
        session_id: sessionId,
        filePath,
        oldContent:
          typeof contentObj.oldContent === "string"
            ? contentObj.oldContent
            : undefined,
        newContent:
          typeof contentObj.newContent === "string"
            ? contentObj.newContent
            : "",
        unifiedDiff:
          typeof contentObj.unifiedDiff === "string"
            ? contentObj.unifiedDiff
            : undefined,
        status,
      },
    ];
  }

  // Default: treat as text
  const text = toTextContent(content);
  if (!text) return [];
  return [
    {
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  ];
}

// ---------------------------------------------------------------------------
// Core session-update dispatcher (Task 3.1)
// ---------------------------------------------------------------------------

/**
 * All known ACP `sessionUpdate` discriminants from the pinned ACP spec
 * @ d212761dd4555d0140fac29e5437256e90ec7997.
 */
export const KNOWN_ACP_SESSION_UPDATE_TYPES = [
  "agent_message_chunk",
  "agent_message",
  "agent_thought_chunk",
  "agent_reasoning_chunk",
  "error",
  "agent_error",
  "tool_call",
  "tool_call_update",
  "plan",
] as const;

export type KnownAcpSessionUpdateType =
  (typeof KNOWN_ACP_SESSION_UPDATE_TYPES)[number];

function parseSessionUpdate(
  params: JsonObject,
  fallbackSessionId: string,
  toolCallTracker?: AcpToolCallTracker,
): ClaudeMessage[] {
  const update = asObject(params.update);
  if (!update) {
    return [];
  }
  const sessionId = getSessionId(params, fallbackSessionId);
  const sessionUpdate =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : "agent_message_chunk";

  switch (sessionUpdate as KnownAcpSessionUpdateType | string) {
    // -----------------------------------------------------------------------
    // Text / thinking chunks
    // -----------------------------------------------------------------------
    case "agent_thought_chunk":
    case "agent_reasoning_chunk": {
      const contentText = toTextContent(update.content);
      if (!contentText) return [];
      return [
        {
          type: "assistant",
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: contentText,
                signature: "acp-synthetic-signature",
              },
            ],
          },
        },
      ];
    }

    case "agent_message_chunk":
    case "agent_message": {
      return handleAgentMessageContent(update.content, sessionId);
    }

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------
    case "error":
    case "agent_error": {
      const contentText = toTextContent(update.content);
      const errorMessage =
        contentText ||
        (typeof update.message === "string" ? update.message : "acp_error");
      return [
        {
          type: "custom-error",
          session_id: null,
          duration_ms: 0,
          error_info: errorMessage,
        },
      ];
    }

    // -----------------------------------------------------------------------
    // Tool-call lifecycle (Task 3.2)
    // -----------------------------------------------------------------------
    case "tool_call": {
      if (!toolCallTracker) return [];
      const msg = toolCallTracker.handleToolCall(update, sessionId);
      return msg ? [msg] : [];
    }

    case "tool_call_update": {
      if (!toolCallTracker) return [];
      const msg = toolCallTracker.handleToolCallUpdate(update, sessionId);
      return msg ? [msg] : [];
    }

    // -----------------------------------------------------------------------
    // Plan (Task 3.3)
    // -----------------------------------------------------------------------
    case "plan": {
      const rawEntries = Array.isArray(update.entries) ? update.entries : [];
      const entries = rawEntries
        .map((e) => {
          const entryObj = asObject(e);
          if (!entryObj) return null;
          const content =
            typeof entryObj.content === "string" ? entryObj.content : "";
          const priority =
            entryObj.priority === "high" ||
            entryObj.priority === "medium" ||
            entryObj.priority === "low"
              ? entryObj.priority
              : ("medium" as const);
          const status =
            entryObj.status === "in_progress" || entryObj.status === "completed"
              ? entryObj.status
              : ("pending" as const);
          const id = typeof entryObj.id === "string" ? entryObj.id : undefined;
          return { id, content, priority, status };
        })
        .filter(Boolean) as Array<{
        id?: string;
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }>;

      return [
        {
          type: "acp-plan",
          session_id: sessionId,
          entries,
        },
      ];
    }

    // -----------------------------------------------------------------------
    // Unknown — throw named error (Task 3.1)
    // -----------------------------------------------------------------------
    default: {
      // TypeScript exhaustiveness hint — the `never` cast documents intent.
      const _unknownType: never = sessionUpdate as never;
      void _unknownType;
      throw new UnknownAcpContentTypeError(sessionUpdate);
    }
  }
}

function parseEnvelopeError(envelope: JsonObject): ClaudeMessage[] {
  const error = asObject(envelope.error);
  if (!error) {
    return [];
  }
  const message =
    typeof error.message === "string" ? error.message : "acp_error";
  return [
    {
      type: "custom-error",
      session_id: null,
      duration_ms: 0,
      error_info: message,
    },
  ];
}

function parseAgentExited(params: JsonObject): ClaudeMessage[] {
  if (params.success === true) {
    return [];
  }
  const code =
    typeof params.code === "number" || typeof params.code === "string"
      ? String(params.code)
      : null;
  const reason = code ? `exit code ${code}` : "unknown exit";
  return [
    {
      type: "custom-error",
      session_id: null,
      duration_ms: 0,
      error_info: `ACP agent exited before producing a response (${reason})`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

/**
 * Coalesce consecutive top-level assistant text-only messages into a single message.
 * ACP transports stream token-by-token, producing many tiny ClaudeMessages. This
 * merges them before sending to the server to reduce DB bloat and improve rendering.
 *
 * Only merges when:
 * - Both messages are type "assistant" with parent_tool_use_id === null
 * - Both messages contain exclusively text content blocks (no tool_use)
 * - Both share the same session_id
 */
export function coalesceAssistantTextMessages(
  messages: ClaudeMessage[],
): ClaudeMessage[] {
  if (messages.length <= 1) {
    return messages;
  }

  const result: ClaudeMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.type === "assistant" &&
      msg.type === "assistant" &&
      prev.parent_tool_use_id === null &&
      msg.parent_tool_use_id === null &&
      prev.session_id === msg.session_id
    ) {
      const prevContent = prev.message.content;
      const currContent = msg.message.content;
      if (Array.isArray(prevContent) && Array.isArray(currContent)) {
        // Merge consecutive text-only messages
        if (
          prevContent.every((c) => c.type === "text") &&
          currContent.every((c) => c.type === "text")
        ) {
          const prevLastText = prevContent[prevContent.length - 1];
          if (prevLastText && prevLastText.type === "text") {
            const mergedText = currContent
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("");
            prevLastText.text += mergedText;
            continue;
          }
        }
        // Merge consecutive thinking-only messages
        if (
          prevContent.every((c) => c.type === "thinking") &&
          currContent.every((c) => c.type === "thinking")
        ) {
          const prevLastThinking = prevContent[prevContent.length - 1];
          if (prevLastThinking && prevLastThinking.type === "thinking") {
            const mergedThinking = currContent
              .map((c) => (c.type === "thinking" ? c.thinking : ""))
              .join("");
            prevLastThinking.thinking += mergedThinking;
            continue;
          }
        }
      }
    }
    result.push(msg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parseAcpLineToClaudeMessages(
  line: string,
  fallbackSessionId: string,
  toolCallTracker?: AcpToolCallTracker,
  options?: {
    allowedTerminalResponseIds?: ReadonlySet<unknown>;
  },
): ClaudeMessage[] {
  let parsed: JsonRpcEnvelope | null = null;
  try {
    parsed = JSON.parse(line) as JsonRpcEnvelope;
  } catch {
    return [];
  }
  const envelope = asObject(parsed);
  if (!envelope) {
    return [];
  }
  // Detect validated JSON-RPC terminal response:
  // {"id":N,"jsonrpc":"2.0","result":{"stopReason":"end_turn"}}.
  // SSE payloads are provider-controlled, so stopReason is only terminal when
  // the caller can tie the envelope id to a daemon-owned control request.
  const resultObj = asObject(envelope.result);
  if (resultObj && typeof resultObj.stopReason === "string") {
    if (!options?.allowedTerminalResponseIds?.has(envelope.id)) {
      recordUnknownEvent({
        transport: "acp",
        method: "jsonrpc/result",
        itemType: "stopReason",
        threadChatId: fallbackSessionId,
        reason: "ignored unvalidated terminal result envelope",
        payload: envelope,
      });
      return [];
    }
    return [
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: false,
        num_turns: 0,
        result: resultObj.stopReason,
        session_id: fallbackSessionId,
      },
    ];
  }

  const method = typeof envelope.method === "string" ? envelope.method : null;
  if (method === "session/update") {
    const params = asObject(envelope.params);
    if (!params) {
      return [];
    }
    try {
      return parseSessionUpdate(params, fallbackSessionId, toolCallTracker);
    } catch (err) {
      if (err instanceof UnknownAcpContentTypeError) {
        // Surface unknown types as assistant text if content exists, or drop.
        // Either way, record the drop so operators can see which ACP
        // sessionUpdate kinds the daemon doesn't recognize yet.
        const update = asObject(params.update);
        const contentText = update ? toTextContent(update.content) : "";
        recordUnknownEvent({
          transport: "acp",
          method: "session/update",
          itemType: err.sessionUpdate,
          threadChatId: getSessionId(params, fallbackSessionId),
          reason: contentText
            ? "surfaced as text (no structured handler)"
            : "dropped (no content)",
          payload: update,
        });
        if (contentText) {
          return [
            {
              type: "assistant",
              session_id: getSessionId(params, fallbackSessionId),
              parent_tool_use_id: null,
              message: {
                role: "assistant",
                content: [{ type: "text", text: contentText }],
              },
            },
          ];
        }
        return [];
      }
      throw err;
    }
  }
  if (method === "_adapter/agent_exited" || method === "adapter/agent_exited") {
    const params = asObject(envelope.params);
    if (!params) {
      return [];
    }
    return parseAgentExited(params);
  }
  return parseEnvelopeError(envelope);
}

// ---------------------------------------------------------------------------
// Raw session-update parser (throws UnknownAcpContentTypeError — for tests)
// ---------------------------------------------------------------------------

/**
 * Parse a session/update envelope's inner update object, throwing
 * `UnknownAcpContentTypeError` for unrecognised discriminants.
 *
 * Used by the exhaustiveness test (Task 3.8) and by callers that want to
 * handle unknown-type errors themselves rather than relying on the catch in
 * `parseAcpLineToClaudeMessages`.
 */
export function parseSessionUpdateStrict(
  params: JsonObject,
  fallbackSessionId: string,
  toolCallTracker?: AcpToolCallTracker,
): ClaudeMessage[] {
  return parseSessionUpdate(params, fallbackSessionId, toolCallTracker);
}
