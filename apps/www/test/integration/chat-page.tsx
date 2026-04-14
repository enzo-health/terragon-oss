/**
 * Chat UI harness for integration tests.
 *
 * Rather than mounting the full <ChatUI> component (which subscribes to live
 * DB streams, uses React Query, and requires a Next.js environment), this
 * harness renders the individual leaf components that the replayer produces:
 * DelegationItemCard, TerminalPartView, and MessagePart.
 *
 * Strategy (option b from the sprint brief): we drive the patch-cache hook
 * _at the component level_ — i.e. we pass synthesized UI parts directly to
 * the renderers and assert the resulting static HTML. This requires zero
 * plumbing beyond what the existing component tests use.
 *
 * Exports:
 *  - renderDelegationItem(delegation) → static HTML string
 *  - renderTerminalPart(part) → static HTML string
 *  - renderMessagePart(part) → static HTML string
 *  - queryDelegationCard(html) → { found, statusText, agentCount }
 *  - queryTerminalOutput(html) → { found, text, kinds }
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DelegationItemCard } from "../../src/components/chat/delegation-item-card";
import { TerminalPartView } from "../../src/components/chat/terminal-part-view";
import { MessagePart } from "../../src/components/chat/message-part";
import type { DBDelegationMessage } from "@terragon/shared";
import type { DBTerminalPart } from "@terragon/shared";
import type { UIPart } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Renderer helpers
// ---------------------------------------------------------------------------

export function renderDelegationItem(delegation: DBDelegationMessage): string {
  return renderToStaticMarkup(<DelegationItemCard delegation={delegation} />);
}

export function renderTerminalPart(part: DBTerminalPart): string {
  return renderToStaticMarkup(<TerminalPartView part={part} />);
}

/**
 * Minimal props required by MessagePart for integration tests.
 */
const DEFAULT_TOOL_PROPS = {
  threadId: "thread-harness",
  threadChatId: "chat-harness",
  isReadOnly: false,
  promptBoxRef: { current: null },
  childThreads: [],
  githubRepoFullName: "test/repo",
  repoBaseBranchName: "main",
  branchName: null,
  messages: [],
};

export function renderMessagePart(part: UIPart): string {
  return renderToStaticMarkup(
    <MessagePart
      part={part}
      githubRepoFullName="test/repo"
      branchName={null}
      baseBranchName="main"
      hasCheckpoint={false}
      toolProps={DEFAULT_TOOL_PROPS}
    />,
  );
}

// ---------------------------------------------------------------------------
// Query helpers — parse static HTML for assertions
// ---------------------------------------------------------------------------

export type DelegationCardQuery = {
  found: boolean;
  /** Value of the data-status attribute on the status badge. */
  statusText: string | null;
  /** Number of receiver agents listed. */
  agentCount: number;
};

export function queryDelegationCard(html: string): DelegationCardQuery {
  const found = html.includes("data-status=");
  const statusMatch = html.match(/data-status="([^"]+)"/);
  const statusText = statusMatch?.[1] ?? null;

  // Each receiver thread renders a chip; count receiver identifiers.
  // Fall back to counting status badges if chips aren't present.
  const agentCountMatch = html.match(/Delegated to (\d+) agents?/);
  const agentCount = agentCountMatch ? parseInt(agentCountMatch[1]!, 10) : 0;

  return { found, statusText, agentCount };
}

export type TerminalOutputQuery = {
  found: boolean;
  /** All text content across stdout/stderr/interaction chunks. */
  text: string;
  /** Set of data-kind values found in the rendered HTML. */
  kinds: Set<string>;
};

export function queryTerminalOutput(html: string): TerminalOutputQuery {
  const found = html.includes("data-kind=");
  const kindMatches = [...html.matchAll(/data-kind="([^"]+)"/g)];
  const kinds = new Set(kindMatches.map((m) => m[1]!));

  // Strip HTML tags to get visible text content.
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { found, text, kinds };
}
