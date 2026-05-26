import type { DaemonCodexEvent } from "./codex-app-server";
import { readString, toRecord } from "./json-read";

/**
 * Per-item-id text accumulators the router reads and mutates. These are the
 * same `Map`s held on `AppServerRunContext` (`agentMessageTextById`,
 * `reasoningTextById`); the router mutates them in place, matching the
 * pre-extraction inline behavior.
 */
export type CodexNotificationContext = {
  agentMessageTextById: Map<string, string>;
  reasoningTextById: Map<string, string>;
};

export type CodexStreamedDelta = {
  messageId: string;
  partIndex: number;
  kind: "text" | "thinking";
  text: string;
};

/**
 * Pure routing decision for a single Codex notification. The caller executes
 * the side effects:
 * - `enqueue-delta`: enqueue `delta`, then RETURN (do not parse).
 * - `skip`: RETURN with no enqueue and no parse.
 * - `flush-then-parse`: optionally enqueue `delta` (the unstreamed tail), then
 *   FALL THROUGH to `parseCodexLine` (the `item.completed` case).
 * - `parse`: FALL THROUGH to `parseCodexLine` (default for events the router
 *   does not special-case).
 */
export type CodexNotificationDecision =
  | { kind: "enqueue-delta"; delta: CodexStreamedDelta }
  | { kind: "skip" }
  | { kind: "flush-then-parse"; delta?: CodexStreamedDelta }
  | { kind: "parse" };

/**
 * Codex item types whose text is streamed live as deltas and persisted under
 * the item id. On `item.completed` any tail the deltas missed is flushed under
 * the same id; the canonical/rich-part representation is then suppressed (see
 * `isDeltaStreamedAssistantMessage`). `agent_message` streams as "text",
 * `reasoning` as "thinking".
 */
function codexStreamedTextChannel(
  context: CodexNotificationContext,
  itemType: string | undefined,
): { accumulated: Map<string, string>; kind: "text" | "thinking" } | null {
  switch (itemType) {
    case "agent_message":
      return { accumulated: context.agentMessageTextById, kind: "text" };
    case "reasoning":
      return { accumulated: context.reasoningTextById, kind: "thinking" };
    default:
      return null;
  }
}

/**
 * The text not yet covered by the streamed deltas. Empty when the stream
 * already holds the full text, or when it diverged from the final text (in
 * which case we trust the stream rather than risk appending a duplicate).
 */
function unstreamedDeltaTail(streamed: string, final: string): string {
  if (streamed.length === 0) return final;
  return final.startsWith(streamed) ? final.slice(streamed.length) : "";
}

/**
 * Decide how a Codex notification should be routed. Mutates the accumulator
 * maps on `context` for `agent_message` / `reasoning` streaming and flushing,
 * mirroring the inline handler this was extracted from.
 *
 * Events not special-cased here (turn lifecycle, thread.started, errors, plan
 * / diff snapshots, etc.) return `{ kind: "parse" }`; the caller owns those
 * branches and only consults this router for the delta / flush / skip routing.
 */
export function routeCodexNotification({
  threadEvent,
  method,
  context,
}: {
  threadEvent: DaemonCodexEvent;
  method: string | undefined;
  context: CodexNotificationContext;
}): CodexNotificationDecision {
  // Intercept agentMessage deltas before they reach parseCodexLine. Route them
  // through the delta buffer for ephemeral streaming to clients, then
  // short-circuit to avoid persisting a DBMessage per character-level
  // accumulation.
  //
  // INVARIANT: this guard's `item.type === "agent_message"` check MUST stay in
  // sync with parseCodexLine's `agent_message` case under `item.updated`. If
  // codex-app-server ever renames this item type, both branches must be updated
  // atomically — otherwise the parser's fall-through default path (which treats
  // unknown types as no-ops) will silently double-persist deltas via the
  // daemon's pass-through to parseCodexLine. A parser unit test asserts the
  // unknown-item-type default is a no-op so the surface area of this invariant
  // is explicit.
  if (threadEvent.type === "item.updated" && threadEvent.item) {
    const item = toRecord(threadEvent.item);
    if (item && item.type === "agent_message") {
      const itemId = readString(item, "id") ?? undefined;
      const messageText = readString(item, "text") ?? undefined;
      if (itemId && messageText) {
        const previousText = context.agentMessageTextById.get(itemId) ?? "";
        const isExplicitDeltaMethod = method === "item/agentMessage/delta";
        const deltaText = isExplicitDeltaMethod
          ? messageText
          : messageText.startsWith(previousText)
            ? messageText.slice(previousText.length)
            : messageText;
        if (isExplicitDeltaMethod) {
          context.agentMessageTextById.set(itemId, previousText + messageText);
        } else {
          context.agentMessageTextById.set(itemId, messageText);
        }
        if (deltaText) {
          return {
            kind: "enqueue-delta",
            delta: {
              messageId: itemId,
              partIndex: 0,
              kind: "text",
              text: deltaText,
            },
          };
        }
      }
      // Deltas were routed through the broadcast buffer above; skip parseCodexLine
      // for agent_message item.updated so we don't also persist a DBMessage per
      // character-level accumulation (parseCodexLine now emits intermediate
      // agent_message rows for replay / test harnesses, but the production daemon
      // already streams deltas and persists the final item.completed).
      return { kind: "skip" };
    }
  }

  // commandExecution/outputDelta carries live command output. We do NOT stream
  // it as a "text" delta: the delta channel only renders as assistant text, so
  // the command's stdout would surface as a raw standalone text blob next to
  // the Bash tool card instead of inside it (the delta's messageId is the
  // command item id, but a TEXT message under that id is a separate thing from
  // the TOOL_CALL under the same id). The command's full output still lands in
  // the Bash card via the `command_execution` completed -> tool_result path.
  // Streaming it live INTO the card needs a tool-progress delta kind
  // (TOOL_CALL_CHUNK), which the delta channel does not yet carry.
  if (
    threadEvent.type === "item.updated" &&
    method === "item/commandExecution/outputDelta"
  ) {
    return { kind: "skip" };
  }

  // Route fileChange/outputDelta through the delta buffer as "text" kind so the
  // client can stream unified-diff output progressively.
  if (
    threadEvent.type === "item.updated" &&
    method === "item/fileChange/outputDelta"
  ) {
    const item = toRecord(threadEvent.item);
    const itemId = item ? (readString(item, "id") ?? undefined) : undefined;
    const delta = item ? (readString(item, "_delta") ?? undefined) : undefined;
    if (itemId && delta) {
      return {
        kind: "enqueue-delta",
        delta: {
          messageId: itemId,
          partIndex: 0,
          kind: "text",
          text: delta,
        },
      };
    }
    return { kind: "skip" };
  }

  // Route reasoning deltas through the delta buffer as "thinking" kind,
  // accumulating per item id so the `item.completed` flush below can detect any
  // tail the deltas did not cover.
  if (
    threadEvent.type === "item.updated" &&
    (method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta" ||
      method === "item/reasoning/summaryPartAdded")
  ) {
    const item = toRecord(threadEvent.item);
    const itemId = item ? (readString(item, "id") ?? undefined) : undefined;
    const text = item ? (readString(item, "text") ?? undefined) : undefined;
    if (itemId && text) {
      const previous = context.reasoningTextById.get(itemId) ?? "";
      context.reasoningTextById.set(itemId, previous + text);
      return {
        kind: "enqueue-delta",
        delta: {
          messageId: itemId,
          partIndex: 0,
          kind: "thinking",
          text,
        },
      };
    }
    return { kind: "skip" };
  }

  // mcpToolCall/progress updates are delta-only — don't persist them as
  // messages; future sprints will surface progress via the UI layer.
  if (method === "item/mcpToolCall/progress") {
    return { kind: "skip" };
  }

  // On `item.completed` for a streamed-text item (agent_message / reasoning),
  // flush any tail the live deltas missed under the SAME item id, so the delta
  // stream holds the complete text even when a message completes without prior
  // `item.updated` deltas. We do NOT return: the event falls through to
  // parseCodexLine so the DBAgentMessage is still persisted. That parsed message
  // carries `_codexItemId`, so its canonical / rich-part representation is
  // suppressed — the delta stream is the single persisted/replayed copy, and a
  // second one under a fresh id is exactly what stacked identical text in the
  // transcript.
  if (threadEvent.type === "item.completed" && threadEvent.item) {
    const item = toRecord(threadEvent.item);
    const channel = item
      ? codexStreamedTextChannel(context, readString(item, "type") ?? undefined)
      : null;
    const itemId = item ? (readString(item, "id") ?? undefined) : undefined;
    const finalText = item
      ? (readString(item, "text") ?? undefined)
      : undefined;
    if (channel && itemId && finalText) {
      const tail = unstreamedDeltaTail(
        channel.accumulated.get(itemId) ?? "",
        finalText,
      );
      channel.accumulated.delete(itemId);
      if (tail) {
        return {
          kind: "flush-then-parse",
          delta: {
            messageId: itemId,
            partIndex: 0,
            kind: channel.kind,
            text: tail,
          },
        };
      }
    }
    return { kind: "flush-then-parse" };
  }

  return { kind: "parse" };
}
