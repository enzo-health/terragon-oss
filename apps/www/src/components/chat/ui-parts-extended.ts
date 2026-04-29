/**
 * Extended UI part types for rich content.
 *
 * These are www-local additions to the shared `UIPart` union.
 * They carry structured data from `DBAgentMessagePart` through to
 * the React renderer without modifying packages/shared (Sprint 5 www-only).
 *
 * Once these types are stable they should be promoted to
 * packages/shared/src/db/ui-messages.ts and the local aliases removed.
 */
import type {
  AllToolParts,
  DBAudioPart,
  DBResourceLinkPart,
  DBTerminalPart,
  DBDiffPart,
  DBAutoApprovalReviewPart,
  DBServerToolUsePart,
  DBWebSearchResultPart,
  DBDelegationMessage,
  UIStructuredPlanPart,
} from "@terragon/shared";
import type { UIPart } from "@terragon/shared";

export type { UIStructuredPlanPart } from "@terragon/shared";

/** Audio part passthrough — shape mirrors DBAudioPart */
export type UIAudioPart = DBAudioPart;

/** Resource-link part passthrough */
export type UIResourceLinkPart = DBResourceLinkPart;

/** Terminal part passthrough */
export type UITerminalPart = DBTerminalPart;

/** Diff part passthrough */
export type UIDiffPart = DBDiffPart;

/** Auto-approval review part passthrough */
export type UIAutoApprovalReviewPart = DBAutoApprovalReviewPart;

/** Server-executed tool call passthrough (e.g. Anthropic `web_search`). */
export type UIServerToolUsePart = DBServerToolUsePart;

/** Server-tool result passthrough (pairs with UIServerToolUsePart by id). */
export type UIWebSearchResultPart = DBWebSearchResultPart;

/**
 * Canonical full delegation payload — matches `DBDelegationMessage` from the
 * wire. The registry's `delegation` entry narrows to this shape so its prop
 * builder is sound (no unsafe cast at the dispatch boundary).
 */
export type UIDelegationPart = DBDelegationMessage;

/**
 * Minimal stub fallback for a delegation that hasn't yet been resolved to a
 * full `DBDelegationMessage`. Carries a distinct `type: "delegation-stub"`
 * discriminator so the registry dispatcher and the message-part renderer can
 * branch on it explicitly rather than via `"delegationId" in part`. Producers
 * that previously emitted `{ type: "delegation", agentName, status, message }`
 * partials should emit `type: "delegation-stub"` so the union narrows
 * cleanly at the dispatch boundary.
 */
export type UIDelegationStubPart = {
  type: "delegation-stub";
  id: string;
  agentName: string;
  message: string;
  status: "initiated" | "running" | "completed" | "failed" | string;
};

/**
 * UI tool part with daemon-side lifecycle fields that aren't on the shared
 * `AllToolParts` union. The fields are carried from `DBToolCall` through
 * `InternalToolPart` into the renderer; widening `AllToolParts` itself is a
 * separate refactor. Centralized here so consumers (e.g. `tool-part.tsx`)
 * can reference one type instead of redeclaring the intersection.
 */
export type UIToolPartWithLifecycle = AllToolParts & {
  progressChunks?: Array<{ seq: number; text: string }>;
  mcpMetadata?: { server: string; tool: string };
  toolStatus?: string;
};

/**
 * Extended UIPart union that includes all rich content types.
 * Used in apps/www rendering pipeline only.
 */
export type UIPartExtended =
  | UIPart
  | UIAudioPart
  | UIResourceLinkPart
  | UITerminalPart
  | UIDiffPart
  | UIAutoApprovalReviewPart
  | UIStructuredPlanPart
  | UIServerToolUsePart
  | UIWebSearchResultPart
  | UIDelegationPart
  | UIDelegationStubPart;
