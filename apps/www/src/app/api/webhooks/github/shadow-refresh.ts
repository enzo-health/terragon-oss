import {
  refreshGitHubPrProjection,
  refreshGitHubRepoProjection,
} from "@/server-lib/github-projection-refresh";
import { resolvePrNumbersFromSha } from "./handlers";

type PullRequestWebhookPayload = {
  action: string;
  repository: {
    full_name: string;
  };
  pull_request: {
    number: number;
  };
};

type IssueCommentWebhookPayload = {
  repository: {
    full_name: string;
  };
  issue: {
    number: number;
    pull_request?: object;
  };
};

type PullRequestReviewWebhookPayload = {
  repository: {
    full_name: string;
  };
  pull_request: {
    number: number;
  };
};

type CheckRunWebhookPayload = {
  repository: {
    full_name: string;
  };
  check_run: {
    head_sha?: string | null;
    pull_requests: Array<{ number: number }>;
  };
};

type CheckSuiteWebhookPayload = {
  repository: {
    full_name: string;
  };
  check_suite: {
    head_sha?: string | null;
    pull_requests: Array<{ number: number }>;
  };
};

type IssuesOpenedWebhookPayload = {
  repository: {
    full_name: string;
  };
};

type ShadowRefreshTarget =
  | {
      kind: "repo";
      repoFullName: string;
    }
  | {
      kind: "pr";
      repoFullName: string;
      prNumber: number;
    };

type ShadowRefreshWebhookEvent =
  | {
      name:
        | "pull_request.opened"
        | "pull_request.reopened"
        | "pull_request.closed"
        | "pull_request.ready_for_review"
        | "pull_request.converted_to_draft"
        | "pull_request.synchronize";
      payload: PullRequestWebhookPayload;
    }
  | {
      name: "issue_comment.created";
      payload: IssueCommentWebhookPayload;
    }
  | {
      name: "pull_request_review.submitted";
      payload: PullRequestReviewWebhookPayload;
    }
  | {
      name: "pull_request_review_comment.created";
      payload: PullRequestReviewWebhookPayload;
    }
  | {
      name:
        | "check_run.completed"
        | "check_run.created"
        | "check_run.rerequested";
      payload: CheckRunWebhookPayload;
    }
  | {
      name: "check_suite.completed" | "check_suite.rerequested";
      payload: CheckSuiteWebhookPayload;
    }
  | {
      name: "issues.opened";
      payload: IssuesOpenedWebhookPayload;
    };

function getUniquePrNumbers(prNumbers: number[]): number[] {
  return [...new Set(prNumbers)];
}

async function getTargetsForCheckRunEvent(
  payload: CheckRunWebhookPayload,
): Promise<ShadowRefreshTarget[]> {
  const repoFullName = payload.repository.full_name;
  const inlinePrNumbers = getUniquePrNumbers(
    payload.check_run.pull_requests.map(
      (pullRequest: { number: number }) => pullRequest.number,
    ),
  );

  if (inlinePrNumbers.length > 0) {
    return inlinePrNumbers.map((prNumber) => ({
      kind: "pr",
      repoFullName,
      prNumber,
    }));
  }

  if (payload.check_run.head_sha) {
    const prNumbers = await resolvePrNumbersFromSha({
      repoFullName,
      headSha: payload.check_run.head_sha,
      includeTerminal: true,
    });

    if (prNumbers.length > 0) {
      return prNumbers.map((prNumber) => ({
        kind: "pr",
        repoFullName,
        prNumber,
      }));
    }
  }

  return [{ kind: "repo", repoFullName }];
}

async function getTargetsForCheckSuiteEvent(
  payload: CheckSuiteWebhookPayload,
): Promise<ShadowRefreshTarget[]> {
  const repoFullName = payload.repository.full_name;
  const inlinePrNumbers = getUniquePrNumbers(
    payload.check_suite.pull_requests.map(
      (pullRequest: { number: number }) => pullRequest.number,
    ),
  );

  if (inlinePrNumbers.length > 0) {
    return inlinePrNumbers.map((prNumber) => ({
      kind: "pr",
      repoFullName,
      prNumber,
    }));
  }

  if (payload.check_suite.head_sha) {
    const prNumbers = await resolvePrNumbersFromSha({
      repoFullName,
      headSha: payload.check_suite.head_sha,
      includeTerminal: true,
    });

    if (prNumbers.length > 0) {
      return prNumbers.map((prNumber) => ({
        kind: "pr",
        repoFullName,
        prNumber,
      }));
    }
  }

  return [{ kind: "repo", repoFullName }];
}

async function getShadowRefreshTargets(
  event: ShadowRefreshWebhookEvent,
): Promise<ShadowRefreshTarget[]> {
  switch (event.name) {
    case "pull_request.opened":
    case "pull_request.reopened":
    case "pull_request.closed":
    case "pull_request.ready_for_review":
    case "pull_request.converted_to_draft":
    case "pull_request.synchronize": {
      return [
        {
          kind: "pr",
          repoFullName: event.payload.repository.full_name,
          prNumber: event.payload.pull_request.number,
        },
      ];
    }
    case "issue_comment.created": {
      const repoFullName = event.payload.repository.full_name;
      if (event.payload.issue.pull_request) {
        return [
          {
            kind: "pr",
            repoFullName,
            prNumber: event.payload.issue.number,
          },
        ];
      }
      return [{ kind: "repo", repoFullName }];
    }
    case "pull_request_review.submitted": {
      return [
        {
          kind: "pr",
          repoFullName: event.payload.repository.full_name,
          prNumber: event.payload.pull_request.number,
        },
      ];
    }
    case "pull_request_review_comment.created": {
      return [
        {
          kind: "pr",
          repoFullName: event.payload.repository.full_name,
          prNumber: event.payload.pull_request.number,
        },
      ];
    }
    case "check_run.completed":
    case "check_run.created":
    case "check_run.rerequested": {
      return getTargetsForCheckRunEvent(event.payload);
    }
    case "check_suite.completed":
    case "check_suite.rerequested": {
      return getTargetsForCheckSuiteEvent(event.payload);
    }
    case "issues.opened": {
      return [
        { kind: "repo", repoFullName: event.payload.repository.full_name },
      ];
    }
  }
}

export async function shadowRefreshGitHubProjectionsForWebhook(
  event: ShadowRefreshWebhookEvent,
): Promise<void> {
  try {
    const targets = await getShadowRefreshTargets(event);

    if (targets.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        if (target.kind === "repo") {
          await refreshGitHubRepoProjection({
            repoFullName: target.repoFullName,
          });
          return;
        }

        await refreshGitHubPrProjection({
          repoFullName: target.repoFullName,
          prNumber: target.prNumber,
        });
      }),
    );

    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }

      const target = targets[index];
      return [
        {
          target,
          reason: result.reason,
        },
      ];
    });

    if (failures.length > 0) {
      console.error("[github webhook] shadow refresh failed", {
        eventName: event.name,
        failures,
      });
    }
  } catch (error) {
    console.error("[github webhook] shadow refresh target resolution failed", {
      eventName: event.name,
      error,
    });
  }
}
