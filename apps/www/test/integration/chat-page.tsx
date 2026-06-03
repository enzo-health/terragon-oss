/**
 * Chat UI harness for integration tests.
 *
 * The live transcript renders through `native-thread.tsx` + the nauval
 * `components/ai/*` leaves: only text, reasoning, and tool calls have a
 * production renderer. The bespoke per-part views (DelegationItemCard,
 * TerminalPartView, DiffPartView, PlanPartView) and the legacy `MessagePart`
 * dispatcher were removed — they had no production caller. This harness no
 * longer imports them.
 *
 * What the turn tests actually need:
 *  - Text rendering: re-pointed at the production `TextPart` (the streamdown
 *    markdown slot that native-thread mounts). `renderMessagePart` renders a
 *    text part through it and returns the static HTML.
 *  - Terminal / delegation assertions: production surfaces these as the
 *    persisted DB part shape that the live AG-UI mapper consumes (terminal
 *    output → tool-block text; delegation → assistant text). The harness query
 *    helpers therefore operate on the DB part objects directly — the data
 *    contract production reads — rather than on a deleted view's DOM.
 *
 * Exports:
 *  - renderMessagePart(part) → static HTML string (text parts via production TextPart)
 *  - queryDelegation(delegation) → { found, statusText, agentCount }
 *  - queryTerminalChunks(part) → { found, text, kinds }
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DBDelegationMessage } from "@terragon/shared";
import type { DBTerminalPart } from "@terragon/shared";
import type { UIPart } from "@terragon/shared";
import { TextPart } from "../../src/components/chat/text-part";

// ---------------------------------------------------------------------------
// Renderer helpers
// ---------------------------------------------------------------------------

/**
 * Render a message part the way the live transcript does. Only text parts have
 * a production renderer (native-thread mounts `TextPart` in its `NativeText`
 * slot); every other part type renders through tool calls or not at all, so
 * this returns "" for them — callers that need richer assertions use the
 * data-shape query helpers below.
 */
export function renderMessagePart(part: UIPart): string {
  if (part.type === "text") {
    return renderToStaticMarkup(<TextPart text={part.text} />);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Data-shape query helpers — assert the persisted part contract production reads
// ---------------------------------------------------------------------------

export type DelegationQuery = {
  found: boolean;
  /** The delegation's persisted status (drives the live assistant-text label). */
  statusText: string | null;
  /** Number of receiver agents — what the live mapper enumerates. */
  agentCount: number;
};

export function queryDelegation(
  delegation: DBDelegationMessage,
): DelegationQuery {
  return {
    found: delegation.type === "delegation",
    statusText: delegation.status,
    agentCount: delegation.receiverThreadIds.length,
  };
}

export type TerminalChunksQuery = {
  found: boolean;
  /** Concatenated chunk text in stream order — the live tool-block body. */
  text: string;
  /** Set of chunk kinds present (stdout / stderr / interaction). */
  kinds: Set<string>;
  /** Per-kind chunk counts, for accumulation assertions. */
  kindCounts: Record<string, number>;
};

export function queryTerminalChunks(part: DBTerminalPart): TerminalChunksQuery {
  const ordered = [...part.chunks].sort((a, b) => a.streamSeq - b.streamSeq);
  const kinds = new Set<string>();
  const kindCounts: Record<string, number> = {};
  for (const chunk of ordered) {
    kinds.add(chunk.kind);
    kindCounts[chunk.kind] = (kindCounts[chunk.kind] ?? 0) + 1;
  }
  return {
    found: part.type === "terminal",
    text: ordered.map((chunk) => chunk.text).join(""),
    kinds,
    kindCounts,
  };
}
