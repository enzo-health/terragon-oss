import type {
  SdlcLoopCauseType,
  SdlcLoopOutboxActionType,
  SdlcLoopOutboxSupersessionGroup,
  SdlcLoopState,
} from "../../db/types";
import type { SdlcLoopTransitionEvent } from "./state-constants";
import { isSdlcLoopTerminalState } from "./state-constants";

export function resolveSdlcLoopNextState({
  currentState,
  event,
}: {
  currentState: SdlcLoopState;
  event: SdlcLoopTransitionEvent;
}): SdlcLoopState | null {
  if (currentState === "done") {
    if (
      event === "video_capture_succeeded" ||
      event === "video_capture_failed" ||
      event === "babysit_passed" ||
      event === "mark_done"
    ) {
      return "done";
    }
    return null;
  }

  if (isSdlcLoopTerminalState(currentState)) {
    return null;
  }

  const globalTransitions: Partial<
    Record<SdlcLoopTransitionEvent, SdlcLoopState>
  > = {
    pr_closed_unmerged: "terminated_pr_closed",
    pr_merged: "terminated_pr_merged",
    manual_stop: "stopped",
    human_feedback_requested: "blocked",
  };
  if (event in globalTransitions) {
    return globalTransitions[event] ?? null;
  }

  switch (currentState) {
    case "planning":
      if (event === "plan_completed") return "implementing";
      if (event === "plan_gate_blocked") return "planning";
      return null;
    case "implementing":
      if (event === "implementation_progress") return "implementing";
      if (event === "implementation_gate_blocked") return "implementing";
      if (event === "implementation_completed") return "review_gate";
      return null;
    case "review_gate":
      if (
        event === "review_blocked" ||
        event === "deep_review_gate_blocked" ||
        event === "carmack_review_gate_blocked"
      ) {
        return "implementing";
      }
      if (event === "review_passed") return "ci_gate";
      if (
        event === "deep_review_gate_passed" ||
        event === "carmack_review_gate_passed"
      ) {
        return "review_gate";
      }
      return null;
    case "ci_gate":
      if (
        event === "ci_gate_blocked" ||
        event === "review_threads_gate_blocked"
      ) {
        return "implementing";
      }
      if (
        event === "ci_gate_passed" ||
        event === "review_threads_gate_passed"
      ) {
        return "ui_gate";
      }
      return null;
    case "ui_gate":
      if (event === "ui_smoke_failed" || event === "video_capture_failed") {
        return "implementing";
      }
      if (event === "ui_smoke_passed" || event === "video_capture_started") {
        return "ui_gate";
      }
      if (event === "pr_linked" || event === "video_capture_succeeded") {
        return "babysitting";
      }
      return null;
    case "awaiting_pr_link":
      if (event === "pr_linked") return "babysitting";
      if (event === "mark_done") return "done";
      return null;
    case "babysitting":
      if (
        event === "babysit_blocked" ||
        event === "ci_gate_blocked" ||
        event === "review_threads_gate_blocked" ||
        event === "deep_review_gate_blocked" ||
        event === "carmack_review_gate_blocked"
      ) {
        return "implementing";
      }
      if (event === "babysit_passed" || event === "mark_done") return "done";
      if (
        event === "pr_linked" ||
        event === "ci_gate_passed" ||
        event === "review_threads_gate_passed" ||
        event === "deep_review_gate_passed" ||
        event === "carmack_review_gate_passed"
      ) {
        return "babysitting";
      }
      return null;
    case "blocked":
      if (
        event === "blocked_resume_requested" ||
        event === "blocked_bypass_once_requested" ||
        event === "implementation_progress"
      ) {
        return "implementing";
      }
      if (event === "mark_done") return "done";
      return null;
    default:
      return null;
  }
}

export const SDLC_CAUSE_IDENTITY_VERSION = 1;
export const GITHUB_WEBHOOK_CLAIM_TTL_MS = 5 * 60 * 1000;

type DaemonTerminalCause = {
  causeType: "daemon_terminal";
  eventId: string;
};

type NonDaemonCause =
  | {
      causeType: "check_run.completed";
      deliveryId: string;
      checkRunId: number | string;
    }
  | {
      causeType: "check_suite.completed";
      deliveryId: string;
      checkSuiteId: number | string;
    }
  | {
      causeType: "pull_request.synchronize";
      deliveryId: string;
      pullRequestId: number | string;
      headSha: string;
    }
  | {
      causeType: "pull_request.closed";
      deliveryId: string;
      pullRequestId: number | string;
      merged: boolean;
    }
  | {
      causeType: "pull_request.reopened";
      deliveryId: string;
      pullRequestId: number | string;
    }
  | {
      causeType: "pull_request.edited";
      deliveryId: string;
      pullRequestId: number | string;
    }
  | {
      causeType: "pull_request_review";
      deliveryId: string;
      reviewId: number | string;
      reviewState: string;
    }
  | {
      causeType: "pull_request_review_comment";
      deliveryId: string;
      commentId: number | string;
    };

type SyntheticPollCause = {
  causeType: "review-thread-poll-synthetic";
  loopId: string;
  pollWindowStartIso: string;
  pollWindowEndIso: string;
  pollSequence: number;
};

export type SdlcCanonicalCauseInput =
  | DaemonTerminalCause
  | NonDaemonCause
  | SyntheticPollCause;

export type SdlcCanonicalCause = {
  causeType: SdlcLoopCauseType;
  canonicalCauseId: string;
  signalHeadShaOrNull: string | null;
  causeIdentityVersion: number;
};

export type GithubWebhookDeliveryClaimOutcome =
  | "claimed_new"
  | "already_completed"
  | "in_progress_fresh"
  | "stale_stolen";

export type GithubWebhookDeliveryClaimResult = {
  outcome: GithubWebhookDeliveryClaimOutcome;
  shouldProcess: boolean;
};

const outboxSupersessionGroupMap: Record<
  SdlcLoopOutboxActionType,
  SdlcLoopOutboxSupersessionGroup
> = {
  publish_status_comment: "publication_status",
  publish_check_summary: "publication_status",
  enqueue_fix_task: "fix_task_enqueue",
  publish_video_link: "publication_video",
  emit_telemetry: "telemetry",
};

export function getSdlcOutboxSupersessionGroup(
  actionType: SdlcLoopOutboxActionType,
): SdlcLoopOutboxSupersessionGroup {
  return outboxSupersessionGroupMap[actionType];
}

export function buildSdlcCanonicalCause(
  input: SdlcCanonicalCauseInput,
): SdlcCanonicalCause {
  switch (input.causeType) {
    case "daemon_terminal":
      return {
        causeType: input.causeType,
        canonicalCauseId: input.eventId,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "check_run.completed":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.checkRunId}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "check_suite.completed":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.checkSuiteId}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.synchronize":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:${input.headSha}`,
        signalHeadShaOrNull: input.headSha,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.closed":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:closed:${input.merged ? "merged" : "unmerged"}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.reopened":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:reopened`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.edited":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:edited`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request_review":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.reviewId}:${input.reviewState}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request_review_comment":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.commentId}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "review-thread-poll-synthetic":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.loopId}:${input.pollWindowStartIso}:${input.pollWindowEndIso}:${input.pollSequence}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    default: {
      const _exhaustive: never = input;
      throw new Error(`Unhandled SDLC canonical cause input: ${_exhaustive}`);
    }
  }
}

export function getGithubWebhookClaimHttpStatus(
  outcome: GithubWebhookDeliveryClaimOutcome,
): number {
  switch (outcome) {
    case "already_completed":
      return 200;
    case "claimed_new":
    case "stale_stolen":
    case "in_progress_fresh":
      return 202;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled GitHub claim outcome: ${_exhaustive}`);
    }
  }
}
