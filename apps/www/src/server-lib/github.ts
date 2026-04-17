import { Endpoints } from "@octokit/types";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { db } from "@/lib/db";
import {
  GithubCheckRunStatus,
  GithubCheckRunConclusion,
  Automation,
} from "@terragon/shared/db/types";
import { getAutomation } from "@terragon/shared/model/automations";
import { publicAppUrl } from "@terragon/env/next-public";

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
    name: `Terragon Automation - ${automation.name}`,
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
  status,
  summary,
  conclusion,
}: {
  userId: string;
  automationId: string;
  checkRunId: number;
  threadIdOrNull: string | null;
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
}
