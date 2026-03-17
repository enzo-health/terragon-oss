import type { DB } from "@terragon/shared/db";
import type { SdlcLoopCauseType } from "@terragon/shared/db/types";
import type {
  DeliverySignal,
  CiEvaluation,
  ReviewEvaluation,
} from "@terragon/shared/delivery-loop/domain/signals";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";

export type GitHubWebhookPayload = {
  action: string;
  prNumber: number;
  repoFullName: string;
  // CI signals
  checkName?: string;
  checkConclusion?: string;
  checkSuiteId?: string;
  requiredChecks?: readonly string[];
  failingChecks?: readonly string[];
  // Review signals
  reviewState?: string;
  unresolvedThreadCount?: number;
  approvalCount?: number;
  requiredApprovals?: number;
  // Per-event identity for deduplication
  reviewId?: string;
  checkRunId?: string;
  commentId?: string;
  // Sync signals
  headSha?: string;
  // Merge signals
  merged?: boolean;
};

/**
 * Normalize a raw GitHub webhook payload to a typed DeliverySignal.
 * Returns null for webhook events that the delivery loop doesn't act on.
 */
export function normalizeGitHubWebhook(
  raw: GitHubWebhookPayload,
): DeliverySignal | null {
  switch (raw.action) {
    case "check_suite_completed":
    case "check_run_completed": {
      let requiredChecks = raw.requiredChecks ?? [];
      let failingChecks = raw.failingChecks ?? [];
      // When the aggregate CI snapshot is unavailable (e.g., transient
      // GitHub API failure), fall back to the triggering check's data
      // so the reducer has enough information to act instead of marking
      // the signal retryable and leaving the workflow stuck.
      if (
        requiredChecks.length === 0 &&
        failingChecks.length === 0 &&
        raw.checkName
      ) {
        requiredChecks = [raw.checkName];
        failingChecks =
          raw.checkConclusion !== "success" ? [raw.checkName] : [];
      }
      const result: CiEvaluation = {
        passed: raw.checkConclusion === "success",
        requiredChecks,
        failingChecks,
      };
      return {
        source: "github",
        event: {
          kind: "ci_changed",
          prNumber: raw.prNumber,
          result,
        },
      };
    }

    case "pull_request_review": {
      // Only actionable review states produce signals. COMMENTED and
      // DISMISSED reviews don't indicate pass/fail — emitting them as
      // passed=false would falsely push the workflow back to implementing.
      if (
        raw.reviewState !== "approved" &&
        raw.reviewState !== "changes_requested"
      ) {
        return null;
      }
      const approvalCount = raw.approvalCount ?? 0;
      const requiredApprovals = raw.requiredApprovals ?? 1;
      const result: ReviewEvaluation = {
        passed:
          raw.reviewState === "approved" &&
          (raw.unresolvedThreadCount ?? 0) === 0 &&
          approvalCount >= requiredApprovals,
        unresolvedThreadCount: raw.unresolvedThreadCount ?? 0,
        approvalCount,
        requiredApprovals,
      };
      return {
        source: "github",
        event: {
          kind: "review_changed",
          prNumber: raw.prNumber,
          result,
        },
      };
    }

    case "pull_request_review_thread": {
      // Thread events don't carry reviewState, so derive pass/fail from
      // thread resolution and approval counts alone.
      const result: ReviewEvaluation = {
        passed:
          (raw.unresolvedThreadCount ?? 0) === 0 &&
          (raw.approvalCount ?? 0) >= (raw.requiredApprovals ?? 1),
        unresolvedThreadCount: raw.unresolvedThreadCount ?? 0,
        approvalCount: raw.approvalCount ?? 0,
        requiredApprovals: raw.requiredApprovals ?? 1,
      };
      return {
        source: "github",
        event: {
          kind: "review_changed",
          prNumber: raw.prNumber,
          result,
        },
      };
    }

    case "closed": {
      return {
        source: "github",
        event: {
          kind: "pr_closed",
          prNumber: raw.prNumber,
          merged: raw.merged ?? false,
        },
      };
    }

    case "synchronize": {
      if (!raw.headSha) return null;
      return {
        source: "github",
        event: {
          kind: "pr_synchronized",
          prNumber: raw.prNumber,
          headSha: raw.headSha,
        },
      };
    }

    default:
      return null;
  }
}

/**
 * Handle an inbound GitHub webhook: normalize to a typed signal,
 * look up the active workflow for the PR, and append the signal
 * to its inbox.
 */
export async function handleGitHubWebhook(params: {
  db: DB;
  rawEvent: GitHubWebhookPayload;
  /** V1 sdlcLoop ID used as inbox partition key. Must match the key cron uses to drain. */
  inboxPartitionKey: string;
  lookupWorkflowByPr: (params: {
    db: DB;
    prNumber: number;
    repoFullName: string;
  }) => Promise<WorkflowId | null>;
  wakeCoordinator?: (workflowId: WorkflowId) => Promise<void>;
}): Promise<void> {
  const signal = normalizeGitHubWebhook(params.rawEvent);
  if (!signal) return;

  const workflowId = await params.lookupWorkflowByPr({
    db: params.db,
    prNumber: params.rawEvent.prNumber,
    repoFullName: params.rawEvent.repoFullName,
  });
  if (!workflowId) return;

  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );

  const causeType = mapGitHubSignalToCauseType(signal);
  await appendSignalToInbox({
    db: params.db,
    loopId: params.inboxPartitionKey,
    causeType,
    payload: signal as Record<string, unknown>,
    canonicalCauseId: `github:${params.rawEvent.repoFullName}:${params.rawEvent.prNumber}:${params.rawEvent.action}:${params.rawEvent.checkRunId ?? params.rawEvent.checkSuiteId ?? params.rawEvent.reviewId ?? params.rawEvent.commentId ?? params.rawEvent.headSha ?? "no-id"}`,
  });

  // Wake coordinator asynchronously
  if (params.wakeCoordinator) {
    params.wakeCoordinator(workflowId).catch((err) => {
      console.warn("[github-ingress] wakeCoordinator failed", {
        workflowId,
        error: err,
      });
    });
  }
}

function mapGitHubSignalToCauseType(signal: DeliverySignal): SdlcLoopCauseType {
  if (signal.source !== "github") return "github_ci_changed";
  switch (signal.event.kind) {
    case "ci_changed":
      return "github_ci_changed";
    case "review_changed":
      return "github_review_changed";
    case "pr_closed":
      return "github_pr_closed";
    case "pr_synchronized":
      return "github_pr_synchronized";
  }
}
