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

export type UIDelegationPart =
  | DBDelegationMessage
  | {
      type: "delegation";
      id: string;
      agentName: string;
      message: string;
      status: "initiated" | "running" | "completed" | "failed" | string;
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
  | UIDelegationPart;
