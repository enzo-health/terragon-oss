import { Octokit } from "octokit";

type PullRequestClient = Pick<Octokit, "graphql"> & {
  rest: {
    pulls: {
      get: Octokit["rest"]["pulls"]["get"];
    };
  };
};

function parseRequestStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function parseRequestMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function parseGraphqlErrorMessages(error: unknown): string[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return [];
  }
  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const message = (entry as { message?: unknown }).message;
      return typeof message === "string" ? message : null;
    })
    .filter((message): message is string => message !== null);
}

function isAlreadyDraftMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already") &&
    normalized.includes("draft") &&
    normalized.includes("pull request")
  );
}

function isAlreadyDraftError(error: unknown): boolean {
  const status = parseRequestStatus(error);
  if (status !== null && status !== 422) {
    return false;
  }

  const messages = [
    parseRequestMessage(error),
    ...parseGraphqlErrorMessages(error),
  ].filter((message) => message.trim().length > 0);

  return messages.some(isAlreadyDraftMessage);
}

async function getPullRequestNodeId({
  octokit,
  owner,
  repo,
  prNumber,
}: {
  octokit: PullRequestClient;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<{ nodeId: string; isDraft: boolean }> {
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  if (!pullRequest.node_id) {
    throw new Error("Pull request node ID is missing");
  }

  return {
    nodeId: pullRequest.node_id,
    isDraft: !!pullRequest.draft,
  };
}

export async function markPullRequestReadyForReview({
  octokit,
  owner,
  repo,
  prNumber,
}: {
  octokit: PullRequestClient;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<void> {
  const { nodeId, isDraft } = await getPullRequestNodeId({
    octokit,
    owner,
    repo,
    prNumber,
  });

  if (!isDraft) {
    return;
  }

  await octokit.graphql(
    `mutation ($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest {
          id
          isDraft
        }
      }
    }`,
    {
      pullRequestId: nodeId,
    },
  );
}

export async function convertPullRequestToDraft({
  octokit,
  owner,
  repo,
  prNumber,
}: {
  octokit: PullRequestClient;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<"converted" | "already_draft"> {
  const { nodeId, isDraft } = await getPullRequestNodeId({
    octokit,
    owner,
    repo,
    prNumber,
  });

  if (isDraft) {
    return "already_draft";
  }

  try {
    await octokit.graphql(
      `mutation ($pullRequestId: ID!) {
        convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            id
            isDraft
          }
        }
      }`,
      {
        pullRequestId: nodeId,
      },
    );
    return "converted";
  } catch (error) {
    if (isAlreadyDraftError(error)) {
      return "already_draft";
    }
    throw error;
  }
}
