import type { SdlcLoopCauseType } from "../../db/types";

export const SDLC_CAUSE_IDENTITY_VERSION = 1;

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
