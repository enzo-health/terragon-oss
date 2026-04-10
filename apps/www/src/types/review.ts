/**
 * Review types for the PR Reviews feature.
 *
 * These types mirror the backend schema and will eventually be replaced
 * with imports from `@terragon/shared/db/types` when the schema branch is merged.
 */

export type ReviewPhase =
  | "ai_reviewing"
  | "waiting_human"
  | "posting"
  | "await_author_fixes"
  | "re_reviewing"
  | "complete"
  | "cancelled";

export type ReviewPRState = "open" | "draft" | "merged" | "closed";

export type ReviewCIStatus = "passing" | "failing" | "pending" | "unknown";

export type ReviewRiskLevel = "low" | "medium" | "high";

export type ReviewCommentPriority = "high" | "medium" | "low";

export type ReviewCommentResolution =
  | "resolved"
  | "partially_resolved"
  | "not_addressed";

export type ReviewDecision =
  | "pending"
  | "approved"
  | "changes_requested"
  | "dismissed";

export interface ReviewDiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface ReviewBotFeedback {
  author: string;
  body: string;
  file?: string;
  line?: number;
  url: string;
  state: string;
}

/** Core review record as returned by the dashboard query. */
export interface ReviewForDashboard {
  id: string;
  prNumber: number;
  prUrl: string;
  repoFullName: string;
  prState: ReviewPRState;
  prTitle: string;
  prAuthor: string;
  ciStatus: ReviewCIStatus;
  hasConflicts: boolean;
  riskLevel: ReviewRiskLevel | null;
  phase: ReviewPhase;
  diffStats: ReviewDiffStats | null;
  createdAt: Date;
  updatedAt: Date;
  /** From the reviewAssignment join */
  assignmentDecision: ReviewDecision | null;
}

/** Full review detail for the curation page. */
export interface ReviewDetail {
  id: string;
  prNumber: number;
  prUrl: string;
  repoFullName: string;
  prState: ReviewPRState;
  prTitle: string;
  prAuthor: string;
  prBaseBranch: string | null;
  prHeadBranch: string | null;
  ciStatus: ReviewCIStatus;
  hasConflicts: boolean;
  riskLevel: ReviewRiskLevel | null;
  summary: string | null;
  codeChangeSummary: string | null;
  doneWell: string | null;
  diffStats: ReviewDiffStats | null;
  botFeedback: ReviewBotFeedback[] | null;
  phase: ReviewPhase;
  triageTicketUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  comments: ReviewCommentDetail[];
  assignment: { decision: ReviewDecision | null; postedAt: Date | null } | null;
}

export interface ReviewCommentDetail {
  id: string;
  authorUserId: string | null;
  priority: ReviewCommentPriority;
  file: string;
  line: number | null;
  body: string;
  included: boolean;
  posted: boolean;
  reviewRound: number;
  resolution: ReviewCommentResolution | null;
  resolutionNote: string | null;
  introducedByPr: boolean | null;
  triageTicketUrl: string | null;
}

/** Phases considered "active" (not terminal). */
export const ACTIVE_PHASES: ReadonlySet<ReviewPhase> = new Set([
  "ai_reviewing",
  "waiting_human",
  "posting",
  "await_author_fixes",
  "re_reviewing",
]);

/** Phases considered "completed" (terminal). */
export const COMPLETED_PHASES: ReadonlySet<ReviewPhase> = new Set([
  "complete",
  "cancelled",
]);
