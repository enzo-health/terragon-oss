import type { Message } from "@ag-ui/core";
import type {
  DBMessage,
  DBUserMessage,
  DBToolCall,
  DBSystemMessage,
} from "@terragon/shared";

// DBAgentMessage and DBToolResult are not exported from @terragon/shared;
// redeclare the shapes used for hydration locally.
type DBAgentMessageLike = Extract<DBMessage, { type: "agent" }>;
type DBToolResultLike = Extract<DBMessage, { type: "tool-result" }>;

/**
 * Convert persisted `DBMessage[]` into AG-UI `Message[]` for hydration.
 *
 * Used as `initialMessages` on `HttpAgent`. The goal is to seed the AG-UI
 * runtime with enough state that it knows the prior conversation before the
 * SSE stream begins emitting live events. We only encode what AG-UI's
 * `Message` union expresses natively (role + text content + tool calls/
 * results). Rich Terragon parts (plans, diffs, artifacts, thinking) are not
 * surfaced — those continue to render from the external TerragonThreadContext
 * in Phase 4. Phase 6 will migrate rendering onto the runtime and this mapper
 * may expand (or be replaced with a MESSAGES_SNAPSHOT event).
 *
 * Unknown DB variants are skipped rather than throwing, consistent with the
 * read-side tolerance rule for the DBMessage discriminated union.
 */
export function dbMessagesToAgUiMessages(dbMessages: DBMessage[]): Message[] {
  const out: Message[] = [];
  let idSeq = 0;
  const nextId = () => `hydrate-${idSeq++}`;

  for (const msg of dbMessages) {
    switch (msg.type) {
      case "user":
        out.push(userMessageToAgUi(msg, nextId()));
        break;
      case "agent":
        out.push(agentMessageToAgUi(msg, nextId()));
        break;
      case "tool-call":
        out.push(toolCallToAgUi(msg, nextId()));
        break;
      case "tool-result":
        out.push(toolResultToAgUi(msg as DBToolResultLike, nextId()));
        break;
      case "system":
        out.push(systemMessageToAgUi(msg, nextId()));
        break;
      // Unknown / unrepresentable variants (git-diff, stop, error, meta,
      // thread-context, thread-context-result, delegation) are skipped.
      default:
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.debug(
            `[ag-ui-hydrate] skipped unsupported message type: ${(msg as { type: string }).type}`,
          );
        }
        break;
    }
  }

  return out;
}

function userMessageToAgUi(msg: DBUserMessage, id: string): Message {
  const content = msg.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "rich-text") {
        return extractRichText(part);
      }
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");

  return {
    id,
    role: "user",
    content,
  };
}

function agentMessageToAgUi(msg: DBAgentMessageLike, id: string): Message {
  const content = msg.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");

  return {
    id,
    role: "assistant",
    content,
  };
}

function toolCallToAgUi(msg: DBToolCall, id: string): Message {
  const argsJson = (() => {
    try {
      return JSON.stringify(msg.parameters ?? {});
    } catch {
      return "{}";
    }
  })();

  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: msg.id,
        type: "function" as const,
        function: {
          name: msg.name,
          arguments: argsJson,
        },
      },
    ],
  };
}

function toolResultToAgUi(msg: DBToolResultLike, id: string): Message {
  // AG-UI's ToolMessageSchema exposes an optional `error` string; when the
  // original DBToolResult was an error we mirror the diagnostic there so
  // downstream consumers can distinguish success/failure.
  return {
    id,
    role: "tool",
    content: msg.result,
    toolCallId: msg.id,
    ...(msg.is_error ? { error: msg.result } : {}),
  };
}

function systemMessageToAgUi(msg: DBSystemMessage, id: string): Message {
  const content = msg.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((s) => s.length > 0)
    .join("\n");

  return {
    id,
    role: "system",
    content: content || `[${msg.message_type}]`,
  };
}

function extractRichText(part: { nodes: unknown[] }): string {
  // DBRichTextNode is a flat union of {type: "text"|"mention"|"link", text}.
  // Concatenate the `text` field from each node.
  const out: string[] = [];
  for (const node of part.nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as { text?: unknown };
    if (typeof n.text === "string") out.push(n.text);
  }
  return out.join("");
}
