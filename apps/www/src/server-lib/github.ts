import { Endpoints } from "@octokit/types";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { db } from "@/lib/db";
import {
  GithubCheckRunStatus,
  GithubCheckRunConclusion,
  Automation,
} from "@leo/shared/db/types";
import {
  getGithubCheckRunForThreadChat,
  upsertGithubCheckRun,
} from "@leo/shared/model/github";
import { getAutomation } from "@leo/shared/model/automations";
import { getThreadMinimal } from "@leo/shared/model/threads";
import { publicAppUrl } from "@leo/env/next-public";

type CreateCheckRunParams =
  Endpoints["POST /repos/{owner}/{repo}/check-runs"]["parameters"];

async function createGitHubCheckRun({
  repoFullName,
  prNumber,
  payload,
}: {
  repoFullName: string;
  prNumber: number;
  payload: Pick<
    CreateCheckRunParams,
    "name" | "output" | "status" | "conclusion"
  >;
}): Promise<number> {
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    // Get the PR to get the head SHA
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    // Create new check run
    const createParams: CreateCheckRunParams = {
      owner,
      repo,
      head_sha: pr.head.sha,
      started_at: new Date().toISOString(),
      ...payload,
    };
    const { data: checkRun } = await octokit.rest.checks.create(createParams);
    const checkRunId = checkRun.id;
    console.log(
      `Created check run ${checkRunId} for PR #${prNumber} in ${repoFullName}`,
    );
    return checkRunId;
  } catch (error) {
    console.error(
      `Failed to create/update check run for PR #${prNumber} in ${repoFullName}:`,
      error,
    );
    throw error;
  }
}

type UpdateCheckRunParams =
  Endpoints["PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}"]["parameters"];

async function updateGitHubCheckRun({
  repoFullName,
  checkRunId,
  payload,
}: {
  repoFullName: string;
  checkRunId: number;
  payload: Pick<
    UpdateCheckRunParams,
    "details_url" | "output" | "status" | "conclusion"
  >;
}): Promise<void> {
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      ...payload,
    });
    console.log(`Updated check run ${checkRunId}`, payload);
  } catch (error) {
    console.error(`Failed to update check run ${checkRunId}:`, error);
  }
}

function getCheckRunPayloadForAutomation({
  automation,
  summary,
  status,
  conclusion,
  threadIdOrNull,
}: {
  automation: Automation;
  summary: string;
  threadIdOrNull: string | null;
  status: GithubCheckRunStatus;
  conclusion?: GithubCheckRunConclusion;
}): Pick<
  CreateCheckRunParams,
  "details_url" | "name" | "output" | "status" | "conclusion"
> {
  return {
    name: `Leo Automation - ${automation.name}`,
    output: {
      title: automation.name,
      summary,
    },
    status,
    conclusion,
    details_url: threadIdOrNull
      ? `${publicAppUrl()}/task/${threadIdOrNull}`
      : undefined,
  };
}

export async function createGitHubCheckRunForAutomation({
  userId,
  automationId,
  prNumber,
}: {
  userId: string;
  automationId: string;
  prNumber: number;
}) {
  const automation = await getAutomation({ db, userId, automationId });
  if (!automation) {
    throw new Error("Automation not found");
  }
  return await createGitHubCheckRun({
    repoFullName: automation.repoFullName,
    prNumber,
    payload: getCheckRunPayloadForAutomation({
      automation,
      summary: `Starting pull request automation... ${automation.id}`,
      status: "queued",
      threadIdOrNull: null,
    }),
  });
}

export async function updateGitHubCheckRunForAutomation({
  userId,
  automationId,
  checkRunId,
  threadIdOrNull,
  threadChatIdOrNull,
  status,
  summary,
  conclusion,
}: {
  userId: string;
  automationId: string;
  checkRunId: number;
  threadIdOrNull: string | null;
  threadChatIdOrNull: string | null;
  status: GithubCheckRunStatus;
  conclusion?: GithubCheckRunConclusion;
  summary: string;
}) {
  console.log(
    `Updating check run ${checkRunId} for automation ${automationId}`,
    {
      status,
      conclusion,
      summary,
      threadIdOrNull,
      threadChatIdOrNull,
    },
  );
  const automation = await getAutomation({ db, userId, automationId });
  if (!automation) {
    throw new Error("Automation not found");
  }
  await updateGitHubCheckRun({
    repoFullName: automation.repoFullName,
    checkRunId,
    payload: getCheckRunPayloadForAutomation({
      automation,
      summary,
      status,
      conclusion,
      threadIdOrNull,
    }),
  });
  if (threadIdOrNull && threadChatIdOrNull) {
    await upsertGithubCheckRun({
      db,
      threadId: threadIdOrNull,
      threadChatId: threadChatIdOrNull,
      checkRunId,
      updates: {
        status,
        conclusion,
      },
    });
  }
}

export async function maybeUpdateGitHubCheckRunForThreadChat({
  userId,
  threadId,
  threadChatId,
  summary,
  status,
  conclusion,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  status: GithubCheckRunStatus;
  conclusion?: GithubCheckRunConclusion;
  summary: string;
}) {
  const checkRun = await getGithubCheckRunForThreadChat({
    db,
    threadId,
    threadChatId,
  });
  if (!checkRun || checkRun.status === "completed") {
    return;
  }
  const thread = await getThreadMinimal({
    db,
    userId,
    threadId,
  });
  if (!thread) {
    return;
  }
  try {
    console.log(
      `Updating check run ${checkRun.checkRunId} for thread ${threadId}`,
      { status, conclusion },
    );
    const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    const { data: checkRunExisting } = await octokit.rest.checks.get({
      owner,
      repo,
      check_run_id: checkRun.checkRunId,
    });
    await updateGitHubCheckRun({
      repoFullName: thread.githubRepoFullName,
      checkRunId: checkRun.checkRunId,
      payload: {
        status,
        conclusion,
        output: {
          title: checkRunExisting.output.title ?? undefined,
          summary,
        },
      },
    });
    await upsertGithubCheckRun({
      db,
      threadId,
      threadChatId,
      checkRunId: checkRun.checkRunId,
      updates: {
        status,
        conclusion,
      },
    });
  } catch (error) {
    console.error(`Failed to update check run ${checkRun.checkRunId}:`, error);
  }
}
