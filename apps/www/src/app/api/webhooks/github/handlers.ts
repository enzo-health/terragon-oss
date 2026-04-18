import { db } from "@/lib/db";
import {
  updateGitHubPR,
  getOctokitForApp,
  getIsPRAuthor,
  getIsIssueAuthor,
  parseRepoFullName,
} from "@/lib/github";
import { getGithubPR } from "@terragon/shared/model/github";
import { handleAppMention } from "./handle-app-mention";
import {
  isAppMentioned,
  getDiffContextStr,
  fetchReviewCommentThreadContext,
} from "./utils";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import {
  getPullRequestAutomationsForRepo,
  getIssueAutomationsForRepo,
} from "@terragon/shared/model/automations";
import {
  PullRequestTriggerConfig,
  IssueTriggerConfig,
} from "@terragon/shared/automations";
import {
  getActiveWorkflowForGithubPR,
  TERMINAL_KINDS,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import {
  runPullRequestAutomation,
  runIssueAutomation,
} from "@/server-lib/automations";
import { Automation } from "@terragon/shared/db/types";
import { routeGithubFeedbackOrSpawnThread } from "./route-feedback";
import type { LoopEvent } from "@/server-lib/delivery-loop/v3/types";
// publicAppUrl is used within utils via postBillingLinkComment
export type PullRequestEvent = EmitterWebhookEvent<"pull_request">["payload"];
export type IssueEvent = EmitterWebhookEvent<"issues">["payload"];
export type IssueCommentEvent = EmitterWebhookEvent<"issue_comment">["payload"];
export type PullRequestReviewCommentEvent =
  EmitterWebhookEvent<"pull_request_review_comment">["payload"];
export type PullRequestReviewEvent =
  EmitterWebhookEvent<"pull_request_review">["payload"];
export type CheckRunEvent = EmitterWebhookEvent<"check_run">["payload"];
export type CheckSuiteEvent = EmitterWebhookEvent<"check_suite">["payload"];

function isActionableCheckFailure(conclusion: string | null): boolean {
  if (!conclusion) {
    return false;
  }
  return [
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
    "stale",
  ].includes(conclusion);
}

function getCheckSignalOutcome(
  conclusion: string | null,
): "pass" | "fail" | null {
  if (conclusion === "success") {
    return "pass";
  }

  if (isActionableCheckFailure(conclusion)) {
    return "fail";
  }

  return null;
}

function getRouteUserIdsForCheckSignal({
  enrolledLoopUserIds,
  signalOutcome,
}: {
  enrolledLoopUserIds: string[];
  signalOutcome: "pass" | "fail";
}): Array<string | null> {
  if (enrolledLoopUserIds.length > 0) {
    return enrolledLoopUserIds;
  }

  if (signalOutcome === "fail") {
    return [null];
  }

  return [];
}

function getRouteUserIdsForReviewSignal({
  enrolledLoopUserIds,
}: {
  enrolledLoopUserIds: string[];
}): Array<string | null> {
  if (enrolledLoopUserIds.length > 0) {
    return enrolledLoopUserIds;
  }

  return [null];
}

function getUniqueUserIdsFromActiveLoops(
  activeLoops: Array<{ userId: string }>,
): string[] {
  const seenUserIds = new Set<string>();
  const routeUserIds: string[] = [];

  for (const loop of activeLoops) {
    if (seenUserIds.has(loop.userId)) {
      continue;
    }
    seenUserIds.add(loop.userId);
    routeUserIds.push(loop.userId);
  }

  return routeUserIds;
}

// Single source of truth for which workflow kinds count as terminal lives in
// `workflow-store.ts`. When a webhook matches a terminal workflow, handlers
// emit a `workflow_resurrected` event so the agent can wake and triage rather
// than silently dropping the signal.
const TERMINAL_WORKFLOW_KINDS: ReadonlySet<string> = new Set(TERMINAL_KINDS);

function isTerminalWorkflowKind(kind: string): boolean {
  return TERMINAL_WORKFLOW_KINDS.has(kind);
}

function splitWorkflowsByTerminality<T extends { kind: string }>(
  workflows: T[],
): { active: T[]; terminal: T[] } {
  const active: T[] = [];
  const terminal: T[] = [];
  for (const w of workflows) {
    if (isTerminalWorkflowKind(w.kind)) {
      terminal.push(w);
    } else {
      active.push(w);
    }
  }
  return { active, terminal };
}

async function emitWorkflowResurrectedForTerminals(params: {
  terminalWorkflows: Array<{ id: string }>;
  deliveryId?: string;
  cause:
    | "check_failure"
    | "review_comment"
    | "pr_comment"
    | "pr_review"
    | "pr_reopened"
    | "pr_synchronize";
  reason: string;
  scopeSuffix: string;
}): Promise<void> {
  if (params.terminalWorkflows.length === 0) {
    return;
  }
  await appendV3EventForWorkflowIds({
    workflowIds: params.terminalWorkflows.map((w) => w.id),
    deliveryId: params.deliveryId,
    idempotencyScope: `resurrection:${params.cause}:${params.scopeSuffix}`,
    event: {
      type: "workflow_resurrected",
      cause: params.cause,
      reason: params.reason,
    },
  });
}

async function appendV3EventForWorkflowIds(params: {
  workflowIds: string[];
  deliveryId?: string;
  idempotencyScope: string;
  event: LoopEvent;
}): Promise<void> {
  const workflowIds = [...new Set(params.workflowIds)];
  if (workflowIds.length === 0) {
    return;
  }

  try {
    const { appendEventAndAdvanceExplicit } = await import(
      "@/server-lib/delivery-loop/v3/kernel"
    );
    await Promise.all(
      workflowIds.map(async (workflowId) => {
        await appendEventAndAdvanceExplicit({
          db,
          workflowId,
          source: "github",
          idempotencyKey: `${params.idempotencyScope}:${params.deliveryId ?? "no-delivery-id"}`,
          event: params.event,
          behavior: {
            applyGateBypass: false,
            drainEffects: true,
          },
        });
      }),
    );
  } catch (error) {
    console.warn("[github webhook] failed to append v3 event", {
      idempotencyScope: params.idempotencyScope,
      workflowCount: workflowIds.length,
      eventType: params.event.type,
      error,
    });
  }
}

function deriveUnresolvedThreadCountFromReviewState(
  reviewState: string | null | undefined,
): number | null {
  if (typeof reviewState !== "string") {
    return null;
  }

  const normalized = reviewState.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized === "approved") {
    return 0;
  }

  if (normalized === "changes_requested") {
    return 1;
  }

  return null;
}

export type CiSignalSnapshot = {
  checkNames: string[];
  failingChecks: string[];
  complete: boolean;
};

function buildCiSignalSnapshotFromCheckRuns(
  checkRuns: Array<{
    name?: string | null;
    status?: string | null;
    conclusion?: string | null;
  }>,
): CiSignalSnapshot | null {
  if (checkRuns.length === 0) {
    return null;
  }

  const checkNames = Array.from(
    new Set(
      checkRuns
        .map((run) => run.name?.trim() ?? "")
        .filter((name) => name.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
  if (checkNames.length === 0) {
    return null;
  }

  const failingChecks = Array.from(
    new Set(
      checkRuns
        .filter((run) => isActionableCheckFailure(run.conclusion ?? null))
        .map((run) => run.name?.trim() ?? "")
        .filter((name) => name.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const complete = checkRuns.every((run) => run.status === "completed");

  return {
    checkNames,
    failingChecks,
    complete,
  };
}

export async function fetchCiSignalSnapshotForHeadSha({
  repoFullName,
  headSha,
}: {
  repoFullName: string;
  headSha: string | null;
}): Promise<CiSignalSnapshot | null> {
  if (!headSha) {
    return null;
  }

  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = (await getOctokitForApp({
      owner,
      repo,
    })) as Awaited<ReturnType<typeof getOctokitForApp>> | null | undefined;
    if (!octokit) {
      return null;
    }
    const response = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });
    const checkRuns = response.data.check_runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
    }));
    const totalCheckRunCount = response.data.total_count;
    if (
      typeof totalCheckRunCount === "number" &&
      totalCheckRunCount > checkRuns.length
    ) {
      const allCheckRuns = [...checkRuns];
      const totalPages = Math.max(1, Math.ceil(totalCheckRunCount / 100));
      for (let page = 2; page <= totalPages; page += 1) {
        const pageResponse = await octokit.rest.checks.listForRef({
          owner,
          repo,
          ref: headSha,
          per_page: 100,
          page,
        });
        const pageRuns = pageResponse.data.check_runs.map((run) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
        }));
        allCheckRuns.push(...pageRuns);
        if (
          pageRuns.length === 0 ||
          allCheckRuns.length >= totalCheckRunCount
        ) {
          break;
        }
      }
      if (allCheckRuns.length < totalCheckRunCount) {
        // GitHub's total_count can be stale or include runs not yet returned
        // (e.g. an off-by-one between total_count and actual results). Log the
        // discrepancy but still build the snapshot from what we have — returning
        // null here would cause handleGateStalenessCheck to loop forever as
        // "pending" even when all fetched runs are already completed+passing.
        console.warn(
          "[github webhook] CI signal snapshot pagination incomplete — proceeding with fetched runs",
          {
            repoFullName,
            headSha,
            totalCheckRunCount,
            fetchedCheckRunCount: allCheckRuns.length,
          },
        );
      }
      return buildCiSignalSnapshotFromCheckRuns(allCheckRuns);
    }
    return buildCiSignalSnapshotFromCheckRuns(checkRuns);
  } catch (error) {
    console.warn("[github webhook] failed to build CI signal snapshot", {
      repoFullName,
      headSha,
      error,
    });
    return null;
  }
}

type PullRequestReviewThreadCountQueryResult = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: {
          hasNextPage?: boolean | null;
          endCursor?: string | null;
        } | null;
        nodes?: Array<{
          isResolved?: boolean | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
};

export async function fetchUnresolvedReviewThreadCount({
  repoFullName,
  prNumber,
}: {
  repoFullName: string;
  prNumber: number;
}): Promise<number | null> {
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = (await getOctokitForApp({
      owner,
      repo,
    })) as Awaited<ReturnType<typeof getOctokitForApp>> | null | undefined;
    if (!octokit) {
      return null;
    }
    if (typeof octokit.graphql !== "function") {
      return null;
    }

    let cursor: string | null = null;
    let unresolvedThreadCount = 0;

    for (let page = 0; page < 20; page += 1) {
      const result: PullRequestReviewThreadCountQueryResult =
        await octokit.graphql<PullRequestReviewThreadCountQueryResult>(
          `
          query TerragonReviewThreads(
            $owner: String!
            $repo: String!
            $prNumber: Int!
            $cursor: String
          ) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $prNumber) {
                reviewThreads(first: 100, after: $cursor) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    isResolved
                  }
                }
              }
            }
          }
        `,
          {
            owner,
            repo,
            prNumber,
            cursor,
          },
        );
      const reviewThreads: NonNullable<
        NonNullable<
          NonNullable<
            PullRequestReviewThreadCountQueryResult["repository"]
          >["pullRequest"]
        >["reviewThreads"]
      > | null = result.repository?.pullRequest?.reviewThreads ?? null;
      if (!reviewThreads) {
        console.warn(
          "[github webhook] review-thread query returned no reviewThreads payload",
          {
            repoFullName,
            prNumber,
            page,
          },
        );
        return null;
      }
      const nodes: Array<{ isResolved?: boolean | null } | null> =
        reviewThreads.nodes ?? [];
      for (const thread of nodes) {
        if (!thread?.isResolved) {
          unresolvedThreadCount += 1;
        }
      }

      const hasNextPage = reviewThreads.pageInfo?.hasNextPage === true;
      const endCursor: string | null =
        reviewThreads.pageInfo?.endCursor ?? null;
      if (!hasNextPage || !endCursor) {
        return unresolvedThreadCount;
      }
      cursor = endCursor;
    }

    console.warn("[github webhook] review-thread query hit pagination cap", {
      repoFullName,
      prNumber,
      unresolvedThreadCount,
    });
    return null;
  } catch (error) {
    console.warn(
      "[github webhook] failed to fetch unresolved review thread count",
      {
        repoFullName,
        prNumber,
        error,
      },
    );
    return null;
  }
}

function getCheckRunFailureDetails(
  checkRun: CheckRunEvent["check_run"],
): string {
  const sections = [
    `Check run "${checkRun.name}" finished with conclusion "${checkRun.conclusion ?? "unknown"}".`,
  ];
  if (checkRun.output.title?.trim()) {
    sections.push(`Title: ${checkRun.output.title.trim()}`);
  }
  if (checkRun.output.summary?.trim()) {
    sections.push(`Summary: ${checkRun.output.summary.trim()}`);
  }
  if (checkRun.output.text?.trim()) {
    sections.push(`Details: ${checkRun.output.text.trim()}`);
  }
  if (checkRun.details_url) {
    sections.push(`Details URL: ${checkRun.details_url}`);
  }
  return sections.join("\n");
}

function getCheckSuiteFailureDetails(
  checkSuite: CheckSuiteEvent["check_suite"],
): string {
  const sections = [
    `Check suite ${checkSuite.id} finished with conclusion "${checkSuite.conclusion ?? "unknown"}".`,
  ];
  if (checkSuite.head_branch?.trim()) {
    sections.push(`Head branch: ${checkSuite.head_branch.trim()}`);
  }
  if (checkSuite.head_sha?.trim()) {
    sections.push(`Head SHA: ${checkSuite.head_sha.trim()}`);
  }
  if (checkSuite.check_runs_url?.trim()) {
    sections.push(`Check runs URL: ${checkSuite.check_runs_url.trim()}`);
  }
  if (checkSuite.url?.trim()) {
    sections.push(`Check suite URL: ${checkSuite.url.trim()}`);
  }
  return sections.join("\n");
}

// Handle pull request events
export async function handlePullRequestStatusChange(
  event: PullRequestEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    const repoName = event.repository.full_name;
    const prNumber = event.pull_request.number;
    const pr = await getGithubPR({ db, repoFullName: repoName, prNumber });
    if (!pr) {
      return;
    }
    console.log(
      `Processing ${event.action} event for PR #${prNumber} in ${repoName}`,
    );
    // Update the PR status
    await updateGitHubPR({
      repoFullName: repoName,
      prNumber,
      createIfNotFound: false,
    });

    if (event.action === "closed") {
      const activeWorkflows = await getActiveWorkflowForGithubPR({
        db,
        repoFullName: repoName,
        prNumber,
      });
      await appendV3EventForWorkflowIds({
        workflowIds: activeWorkflows.map((workflow) => workflow.id),
        deliveryId,
        idempotencyScope: `pull_request.closed:${repoName}:${prNumber}:${event.pull_request.merged ? "merged" : "closed"}`,
        event: {
          type: "pr_closed",
          merged: event.pull_request.merged === true,
        },
      });
    }

    // Resurrect terminal workflows on reopen. A user reopened a PR that was
    // previously done / stopped / terminated — bring the thread back so the
    // agent can pick up whatever conversation prompted the reopen. Include
    // the current head SHA in the scope so a reopen-close-reopen sequence
    // doesn't collide on idempotency with the first reopen.
    if (event.action === "reopened") {
      const matched = await getActiveWorkflowForGithubPR({
        db,
        repoFullName: repoName,
        prNumber,
        includeTerminal: true,
      });
      const { terminal } = splitWorkflowsByTerminality(matched);
      await emitWorkflowResurrectedForTerminals({
        terminalWorkflows: terminal,
        deliveryId,
        cause: "pr_reopened",
        reason: `PR #${prNumber} reopened`,
        scopeSuffix: `${repoName}:${prNumber}:${event.pull_request.head?.sha ?? "unknown-sha"}`,
      });
    }

    // Resurrect terminal workflows when a NEW non-Terragon commit lands on the
    // PR branch. We only care about `synchronize` for terminal states — active
    // workflows either already own the push or will handle the follow-up CI
    // events naturally.
    if (event.action === "synchronize") {
      const matched = await getActiveWorkflowForGithubPR({
        db,
        repoFullName: repoName,
        prNumber,
        includeTerminal: true,
      });
      const { terminal } = splitWorkflowsByTerminality(matched);
      await emitWorkflowResurrectedForTerminals({
        terminalWorkflows: terminal,
        deliveryId,
        cause: "pr_synchronize",
        reason: `New commit pushed to PR #${prNumber} branch`,
        scopeSuffix: `${repoName}:${prNumber}:${event.pull_request.head?.sha ?? "unknown-sha"}`,
      });
    }

    console.log(`Successfully updated PR #${prNumber} status in ${repoName}`);
    return;
  } catch (error) {
    console.error("Error updating pull request status:", error);
    throw error;
  }
}

export async function handlePullRequestUpdated(
  event: PullRequestEvent,
): Promise<void> {
  const repoFullName = event.repository.full_name;
  const prNumber = event.pull_request.number;
  console.log(
    `Pull request updated: ${event.action} for PR #${prNumber} in ${repoFullName}`,
  );
  try {
    // Get all pull request automations for this repository
    const automations = await getPullRequestAutomationsForRepo({
      db,
      repoFullName,
    });
    if (automations.length === 0) {
      return;
    }
    console.log(
      `Found ${automations.length} pull request automations for ${repoFullName}`,
    );
    // Process each automation
    for (let i = 0; i < automations.length; i += BATCH_SIZE) {
      const batch = automations.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((automation) =>
          handlePullRequestAutomation(event, automation),
        ),
      );
      const failed = results.filter((result) => result.status === "rejected");
      const succeeded = results.filter(
        (result) => result.status === "fulfilled",
      );
      console.log(
        `Successfully handled ${succeeded.length} pull request automations`,
      );
      if (failed.length > 0) {
        console.error(
          `Error handling ${failed.length} pull request automations: ${failed.map((result) => result.reason).join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error("Error handling pull request updated event:", error);
    throw error;
  }
}

const BATCH_SIZE = 5;

async function handlePullRequestAutomation(
  event: PullRequestEvent,
  automation: Automation,
): Promise<void> {
  const prNumber = event.pull_request.number;
  const repoFullName = event.repository.full_name;
  if (automation.repoFullName !== repoFullName) {
    return;
  }
  const config = automation.triggerConfig as PullRequestTriggerConfig;
  // Check if this automation should trigger for the current event
  let shouldTrigger = false;
  switch (event.action) {
    case "opened":
    case "ready_for_review": {
      shouldTrigger = !!config.on.open;
      break;
    }
    case "synchronize": {
      shouldTrigger = !!config.on.update;
      break;
    }
    default: {
      shouldTrigger = false;
    }
  }
  if (!shouldTrigger) {
    console.log(
      `Automation ${automation.id} not configured to trigger on ${event.action}`,
    );
    return;
  }
  // Check filter conditions
  if (event.pull_request.draft && !config.filter.includeDraftPRs) {
    console.log(
      `Skipping automation ${automation.id} for draft PR #${prNumber} in ${repoFullName}`,
    );
    return;
  }
  const prAuthorUserName = event.pull_request.user?.login;
  const isPRAuthor = await getIsPRAuthor({
    userId: automation.userId,
    repoFullName,
    prNumber,
  });

  let authorMatches = isPRAuthor;
  if (
    !authorMatches &&
    config.filter.includeOtherAuthors &&
    prAuthorUserName &&
    config.filter.otherAuthors
  ) {
    const allowedAuthors = config.filter.otherAuthors
      .split(",")
      .map((author) => author.trim().toLowerCase());
    if (allowedAuthors.includes(prAuthorUserName.toLowerCase())) {
      authorMatches = true;
    }
  }
  if (!authorMatches) {
    console.log(
      `Skipping automation ${automation.id} - PR author ${prAuthorUserName} not in allowed list`,
    );
    return;
  }
  console.log(
    `Triggering automation ${automation.id} for PR #${prNumber} in ${repoFullName} (${event.action})`,
  );
  await runPullRequestAutomation({
    automationId: automation.id,
    userId: automation.userId,
    prEventAction: event.action,
    repoFullName,
    prNumber,
    source: "automated",
  }).catch((error) => {
    console.error(
      `Error running automation ${automation.id} for PR #${prNumber} in ${repoFullName}:`,
      error,
    );
  });
}

// Handle issue comment events
export async function handleIssueCommentEvent(
  event: IssueCommentEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    // Only process newly created comments
    if (event.action !== "created") {
      console.log(`Ignoring issue_comment action: ${event.action}`);
      return;
    }
    if (event.comment.user === null) {
      console.log("Ignoring issue comment event: Comment user is null");
      return;
    }
    const commentBody = event.comment.body;
    const issueNumber = event.issue.number;
    const issueType = event.issue.pull_request ? "pull_request" : "issue";
    const commentUsername = event.comment.user.login;
    const commentUserId = event.comment.user.id;
    const repoFullName = event.repository.full_name;
    const isMention = isAppMentioned(commentBody);

    // PR comments (not issue comments) should wake the agent for triage even
    // without an @mention — the author posted a comment on their thread's PR,
    // the agent should see it. Route through the feedback queue like
    // pull_request_review_comment does.
    if (issueType === "pull_request") {
      const matched = await getActiveWorkflowForGithubPR({
        db,
        repoFullName,
        prNumber: issueNumber,
        includeTerminal: true,
      });
      const { terminal } = splitWorkflowsByTerminality(matched);
      await emitWorkflowResurrectedForTerminals({
        terminalWorkflows: terminal,
        deliveryId,
        cause: "pr_comment",
        reason: `Comment on PR #${issueNumber}`,
        scopeSuffix: `${repoFullName}:${issueNumber}:${event.comment.id}`,
      });

      const enrolledLoopUserIds = getUniqueUserIdsFromActiveLoops(matched);
      if (enrolledLoopUserIds.length > 0) {
        await Promise.all(
          enrolledLoopUserIds.map(async (routeUserId) => {
            const feedbackRoutingResult =
              await routeGithubFeedbackOrSpawnThread({
                userId: routeUserId,
                repoFullName,
                prNumber: issueNumber,
                eventType: "issue_comment.created",
                deliveryId,
                reviewBody: commentBody,
                commentId: event.comment.id,
                sourceType: isMention ? "github-mention" : "automation",
                authorGitHubAccountId: event.issue.user?.id,
              });
            console.log("GitHub feedback routed from PR comment", {
              repoFullName,
              prNumber: issueNumber,
              enrolledWorkflowCount: matched.length,
              enrolledLoopUserCount: enrolledLoopUserIds.length,
              routeUserId,
              ...feedbackRoutingResult,
            });
          }),
        );
      }
    }

    // Check if the comment mentions our app
    if (!isMention) {
      console.log(
        `Comment on ${issueType} #${issueNumber} does not mention the app`,
      );
      return;
    }
    console.log(
      `Processing app mention in comment on ${issueType} #${issueNumber} in ${repoFullName} by ${commentUsername}`,
    );
    // Handle the app mention (this will check for automations internally)
    await handleAppMention({
      repoFullName,
      issueOrPrType: issueType,
      issueOrPrNumber: issueNumber,
      commentId: event.comment.id,
      commentBody,
      commentGitHubAccountId: commentUserId,
      commentGitHubUsername: commentUsername,
      commentType: "issue_comment",
      issueContext:
        issueType === "issue"
          ? `**${event.issue.title}**\n\n${event.issue.body ?? ""}`
          : undefined,
    });
    return;
  } catch (error) {
    console.error("Error handling issue comment event:", error);
    throw error;
  }
}

// Handle pull request review comment events
export async function handlePullRequestReviewCommentEvent(
  event: PullRequestReviewCommentEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    // Only process newly created comments
    if (event.action !== "created") {
      console.log(
        `Ignoring pull_request_review_comment action: ${event.action}`,
      );
      return;
    }
    if (event.comment.user === null) {
      console.log(
        "Ignoring pull request review comment event: Comment user is null",
      );
      return;
    }
    const commentBody = event.comment.body;
    const prNumber = event.pull_request.number;
    const repoFullName = event.repository.full_name;
    const commentUsername = event.comment.user.login;
    const commentUserId = event.comment.user.id;
    const isMention = isAppMentioned(commentBody);
    const matchedWorkflows = await getActiveWorkflowForGithubPR({
      db,
      repoFullName,
      prNumber,
      includeTerminal: true,
    });
    const { active: activeWorkflows, terminal: terminalWorkflows } =
      splitWorkflowsByTerminality(matchedWorkflows);
    await emitWorkflowResurrectedForTerminals({
      terminalWorkflows,
      deliveryId,
      cause: "review_comment",
      reason: `Review comment on PR #${prNumber}`,
      scopeSuffix: `${repoFullName}:${prNumber}:${event.comment.id}`,
    });
    const enrolledLoopUserIds =
      getUniqueUserIdsFromActiveLoops(matchedWorkflows);
    const shouldSkipFeedbackRoutingForMention =
      isMention && enrolledLoopUserIds.length === 0;
    const routeUserIds = shouldSkipFeedbackRoutingForMention
      ? []
      : getRouteUserIdsForReviewSignal({
          enrolledLoopUserIds,
        });

    const feedbackRoutingResults =
      routeUserIds.length > 0
        ? await Promise.all(
            routeUserIds.map(async (routeUserId) => {
              const feedbackRoutingResult =
                await routeGithubFeedbackOrSpawnThread({
                  userId: routeUserId ?? undefined,
                  repoFullName,
                  prNumber,
                  eventType: "pull_request_review_comment.created",
                  deliveryId,
                  reviewBody: commentBody,
                  commentId: event.comment.id,
                  sourceType: isMention ? "github-mention" : "automation",
                  unresolvedThreadCount: 1,
                  unresolvedThreadCountSource: "review_state_heuristic",
                  headSha: event.pull_request.head?.sha ?? undefined,
                  authorGitHubAccountId: event.pull_request.user?.id,
                  baseBranchName: event.pull_request.base?.ref,
                  headBranchName: event.pull_request.head?.ref,
                });
              console.log("GitHub feedback routed from review comment", {
                repoFullName,
                prNumber,
                enrolledWorkflowCount: activeWorkflows.length,
                terminalWorkflowCount: terminalWorkflows.length,
                enrolledLoopUserCount: enrolledLoopUserIds.length,
                routeUserId: routeUserId ?? null,
                ...feedbackRoutingResult,
              });
              return feedbackRoutingResult;
            }),
          )
        : [];
    const hasConcreteFeedbackRouting = feedbackRoutingResults.some(
      (result) => result?.mode !== "noop_owner_unresolved",
    );

    // Check if the comment mentions our app
    if (!isMention) {
      console.log(
        `Review comment on PR #${prNumber} in ${repoFullName} does not mention the app`,
      );
      return;
    }
    if (hasConcreteFeedbackRouting) {
      console.log(
        `Skipping app-mention direct routing because feedback routing already handled PR #${prNumber} in ${repoFullName}`,
      );
      return;
    }
    console.log(
      `Processing app mention in review comment on PR #${prNumber} in ${repoFullName} by ${commentUsername}`,
    );

    // Extract diff context for PR review comments
    const diffContext = getDiffContextStr(event.comment);
    // Fetch review comment thread context if this is a reply
    let commentContext: string | undefined;
    if (event.comment.in_reply_to_id) {
      const [owner, repo] = parseRepoFullName(repoFullName);
      const octokit = await getOctokitForApp({ owner, repo });
      commentContext = await fetchReviewCommentThreadContext({
        octokit,
        owner,
        repo,
        prNumber,
        currentCommentId: event.comment.id,
        inReplyToId: event.comment.in_reply_to_id,
      });
    }

    // Handle the app mention (this will check for automations internally)
    await handleAppMention({
      repoFullName,
      issueOrPrNumber: prNumber,
      issueOrPrType: "pull_request",
      commentId: event.comment.id,
      commentBody,
      commentGitHubAccountId: commentUserId,
      commentGitHubUsername: commentUsername,
      commentType: "review_comment",
      diffContext,
      commentContext,
    });

    return;
  } catch (error) {
    console.error("Error handling pull request review comment event:", error);
    throw error;
  }
}

// Handle pull request review events
export async function handlePullRequestReviewEvent(
  event: PullRequestReviewEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    // Only process newly submitted reviews
    if (event.action !== "submitted") {
      console.log(`Ignoring pull_request_review action: ${event.action}`);
      return;
    }
    if (event.review.user === null) {
      console.log("Ignoring pull request review event: Review user is null");
      return;
    }

    const reviewBody = event.review.body;
    const prNumber = event.pull_request.number;
    const repoFullName = event.repository.full_name;
    const reviewUsername = event.review.user.login;
    const reviewUserId = event.review.user.id;
    const isMention = !!reviewBody && isAppMentioned(reviewBody);
    const unresolvedThreadCountFromGithub =
      await fetchUnresolvedReviewThreadCount({
        repoFullName,
        prNumber,
      });
    const unresolvedThreadCountFromReviewState =
      deriveUnresolvedThreadCountFromReviewState(event.review.state);
    const unresolvedThreadCount =
      unresolvedThreadCountFromGithub ?? unresolvedThreadCountFromReviewState;
    const unresolvedThreadCountSource =
      unresolvedThreadCountFromGithub !== null
        ? "github_graphql"
        : unresolvedThreadCountFromReviewState !== null
          ? "review_state_heuristic"
          : undefined;

    const matchedWorkflows = await getActiveWorkflowForGithubPR({
      db,
      repoFullName,
      prNumber,
      includeTerminal: true,
    });
    const { active: activeWorkflows, terminal: terminalWorkflows } =
      splitWorkflowsByTerminality(matchedWorkflows);
    const normalizedReviewState = event.review.state.trim().toLowerCase();
    let v3ReviewEvent: LoopEvent | null = null;
    if (normalizedReviewState === "changes_requested") {
      v3ReviewEvent = {
        type: "gate_review_failed",
        runId: event.review.commit_id ?? null,
        reason: reviewBody?.trim() || "Review requested changes",
      };
    } else if (normalizedReviewState === "approved") {
      if (unresolvedThreadCount !== null && unresolvedThreadCount > 0) {
        v3ReviewEvent = {
          type: "gate_review_failed",
          runId: event.review.commit_id ?? null,
          reason: `Review approved but ${unresolvedThreadCount} unresolved thread(s) remain`,
        };
      } else {
        v3ReviewEvent = {
          type: "gate_review_passed",
          runId: event.review.commit_id ?? null,
        };
      }
    }
    if (v3ReviewEvent) {
      await appendV3EventForWorkflowIds({
        workflowIds: activeWorkflows.map((workflow) => workflow.id),
        deliveryId,
        idempotencyScope: `pull_request_review.submitted:${repoFullName}:${prNumber}:${event.review.id}:${normalizedReviewState}`,
        event: v3ReviewEvent,
      });
    }
    // Terminal workflows can't accept gate_review_* events (the reducer drops
    // them on terminal states). Resurrect only when the review is actually
    // actionable: changes_requested, or any review with a non-empty body.
    // An "approved" review with no body is just a thumbs-up on a shipped PR —
    // no reason to wake the agent.
    const reviewIsActionable =
      normalizedReviewState === "changes_requested" ||
      (reviewBody != null && reviewBody.trim().length > 0);
    if (reviewIsActionable) {
      await emitWorkflowResurrectedForTerminals({
        terminalWorkflows,
        deliveryId,
        cause: "pr_review",
        reason:
          reviewBody?.trim() ||
          `Review ${normalizedReviewState} on PR #${prNumber}`,
        scopeSuffix: `${repoFullName}:${prNumber}:${event.review.id}`,
      });
    }

    const enrolledLoopUserIds =
      getUniqueUserIdsFromActiveLoops(matchedWorkflows);
    const shouldSkipFeedbackRoutingForMention =
      isMention && enrolledLoopUserIds.length === 0;
    const routeUserIds = shouldSkipFeedbackRoutingForMention
      ? []
      : getRouteUserIdsForReviewSignal({
          enrolledLoopUserIds,
        });

    const feedbackRoutingResults =
      routeUserIds.length > 0
        ? await Promise.all(
            routeUserIds.map(async (routeUserId) => {
              const feedbackRoutingResult =
                await routeGithubFeedbackOrSpawnThread({
                  userId: routeUserId ?? undefined,
                  repoFullName,
                  prNumber,
                  eventType: "pull_request_review.submitted",
                  deliveryId,
                  reviewBody: reviewBody ?? undefined,
                  commentId: event.review.id,
                  reviewId: event.review.id,
                  reviewState: event.review.state,
                  unresolvedThreadCount: unresolvedThreadCount ?? undefined,
                  unresolvedThreadCountSource,
                  headSha: event.pull_request.head?.sha ?? undefined,
                  failureDetails: `Review state: ${event.review.state}`,
                  sourceType: isMention ? "github-mention" : "automation",
                  authorGitHubAccountId: event.pull_request.user?.id,
                  baseBranchName: event.pull_request.base?.ref,
                  headBranchName: event.pull_request.head?.ref,
                });
              console.log("GitHub feedback routed from review", {
                repoFullName,
                prNumber,
                reviewState: event.review.state,
                unresolvedThreadCount: unresolvedThreadCount ?? null,
                unresolvedThreadCountSource:
                  unresolvedThreadCountSource ?? null,
                enrolledWorkflowCount: activeWorkflows.length,
                enrolledLoopUserCount: enrolledLoopUserIds.length,
                routeUserId: routeUserId ?? null,
                ...feedbackRoutingResult,
              });
              return feedbackRoutingResult;
            }),
          )
        : [];
    const hasConcreteFeedbackRouting = feedbackRoutingResults.some(
      (result) => result?.mode !== "noop_owner_unresolved",
    );

    // Check if the review body exists and mentions our app
    if (!isMention) {
      console.log(
        `Review on PR #${prNumber} in ${repoFullName} does not mention the app or has no body`,
      );
      return;
    }
    if (hasConcreteFeedbackRouting) {
      console.log(
        `Skipping app-mention direct routing because feedback routing already handled PR #${prNumber} in ${repoFullName}`,
      );
      return;
    }
    console.log(
      `Processing app mention in review on PR #${prNumber} in ${repoFullName} by ${reviewUsername}`,
    );

    // Note: PR reviews themselves don't support reactions, only review comments do
    // So we'll just handle the app mention without adding a reaction

    // Handle the app mention (this will check for automations internally)
    await handleAppMention({
      repoFullName,
      issueOrPrNumber: prNumber,
      issueOrPrType: "pull_request",
      commentId: event.review.id,
      commentBody: reviewBody,
      commentGitHubUsername: reviewUsername,
      commentGitHubAccountId: reviewUserId,
    });
    return;
  } catch (error) {
    console.error("Error handling pull request review event:", error);
    throw error;
  }
}

export async function resolvePrNumbersFromSha({
  repoFullName,
  headSha,
  includeTerminal,
}: {
  repoFullName: string;
  headSha: string;
  // When true, include PRs whose delivery workflow is in a terminal state.
  // Webhook handlers that may resurrect a finished thread need this so a
  // check_suite without inline pull_requests[] can still route to the
  // already-shipped thread's workflow.
  includeTerminal?: boolean;
}): Promise<number[]> {
  const [owner, repo] = parseRepoFullName(repoFullName);

  const [githubPrNumbers, dbPrNumbers] = await Promise.all([
    (async (): Promise<number[]> => {
      try {
        const octokit = await getOctokitForApp({ owner, repo });
        const { data } =
          await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
            owner,
            repo,
            commit_sha: headSha,
          });
        return data.filter((pr) => pr.state === "open").map((pr) => pr.number);
      } catch (error) {
        console.error(
          `GitHub API SHA→PR lookup failed for ${repoFullName}@${headSha}`,
          error,
        );
        return [];
      }
    })(),
    (async (): Promise<number[]> => {
      const whereClauses = [
        eq(schema.deliveryWorkflow.repoFullName, repoFullName),
        eq(schema.deliveryWorkflow.currentHeadSha, headSha),
        isNotNull(schema.deliveryWorkflow.prNumber),
      ];
      if (!includeTerminal) {
        whereClauses.push(
          notInArray(schema.deliveryWorkflow.kind, [
            "done",
            "stopped",
            "terminated",
          ]),
        );
      }
      const workflows = await db.query.deliveryWorkflow.findMany({
        where: and(...whereClauses),
        columns: { prNumber: true },
      });
      return [
        ...new Set(
          workflows
            .map((w) => w.prNumber)
            .filter((n): n is number => n !== null),
        ),
      ];
    })(),
  ]);

  return [...new Set([...githubPrNumbers, ...dbPrNumbers])];
}

// Handle check run events
export async function handleCheckRunEvent(
  event: CheckRunEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    const repoFullName = event.repository.full_name;
    const checkRun = event.check_run;
    let prNumbers = checkRun.pull_requests.map((pr) => pr.number);
    if (prNumbers.length === 0 && checkRun.head_sha) {
      console.log(
        `Check run ${checkRun.id} has no associated PRs inline, resolving from SHA ${checkRun.head_sha}`,
      );
      prNumbers = await resolvePrNumbersFromSha({
        repoFullName,
        headSha: checkRun.head_sha,
        includeTerminal: true,
      });
    }
    if (prNumbers.length === 0) {
      console.log(
        `Check run ${checkRun.id} has no associated PRs after SHA fallback, skipping`,
      );
      return;
    }
    console.log(
      `Processing check run ${event.action} for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    await Promise.all(
      prNumbers.map(async (prNumber) => {
        await updateGitHubPR({
          repoFullName,
          prNumber,
          createIfNotFound: false,
        });
      }),
    );

    if (event.action === "completed") {
      const signalOutcome = getCheckSignalOutcome(checkRun.conclusion);
      if (signalOutcome) {
        const ciSnapshot = await fetchCiSignalSnapshotForHeadSha({
          repoFullName,
          headSha: checkRun.head_sha ?? null,
        });
        const failureDetails =
          signalOutcome === "fail"
            ? getCheckRunFailureDetails(checkRun)
            : undefined;

        await Promise.all(
          prNumbers.map(async (prNumber) => {
            const matchedWorkflows = await getActiveWorkflowForGithubPR({
              db,
              repoFullName,
              prNumber,
              includeTerminal: true,
            });
            const { active: activeWorkflows, terminal: terminalWorkflows } =
              splitWorkflowsByTerminality(matchedWorkflows);
            const v3CiEvent: LoopEvent =
              signalOutcome === "pass"
                ? {
                    type: "gate_ci_passed",
                    runId: String(checkRun.id),
                    headSha: checkRun.head_sha ?? null,
                  }
                : {
                    type: "gate_ci_failed",
                    runId: String(checkRun.id),
                    headSha: checkRun.head_sha ?? null,
                    reason: failureDetails ?? "CI checks failed",
                  };
            await appendV3EventForWorkflowIds({
              workflowIds: activeWorkflows.map((workflow) => workflow.id),
              deliveryId,
              idempotencyScope: `check_run.completed:${repoFullName}:${prNumber}:${checkRun.id}:${signalOutcome}`,
              event: v3CiEvent,
            });
            // CI failure on a terminated thread's PR — resurrect so the agent
            // can triage. Passes don't warrant waking a terminal thread.
            if (signalOutcome === "fail") {
              await emitWorkflowResurrectedForTerminals({
                terminalWorkflows,
                deliveryId,
                cause: "check_failure",
                reason: failureDetails ?? `Check ${checkRun.name} failed`,
                scopeSuffix: `${repoFullName}:${prNumber}:${checkRun.id}`,
              });
            }

            const enrolledLoopUserIds =
              getUniqueUserIdsFromActiveLoops(matchedWorkflows);
            const routeUserIds = getRouteUserIdsForCheckSignal({
              enrolledLoopUserIds,
              signalOutcome,
            });

            if (routeUserIds.length === 0) {
              return;
            }

            await Promise.all(
              routeUserIds.map(async (routeUserId) => {
                const feedbackRoutingResult =
                  await routeGithubFeedbackOrSpawnThread({
                    userId: routeUserId ?? undefined,
                    repoFullName,
                    prNumber,
                    eventType: "check_run.completed",
                    deliveryId,
                    checkName: checkRun.name,
                    checkOutcome: signalOutcome,
                    headSha: checkRun.head_sha ?? undefined,
                    checkSummary: `${checkRun.name} (${checkRun.status}:${signalOutcome})`,
                    failureDetails,
                    checkRunId: checkRun.id,
                    ciSnapshotSource: ciSnapshot
                      ? "github_check_runs"
                      : undefined,
                    ciSnapshotCheckNames: ciSnapshot?.checkNames,
                    ciSnapshotFailingChecks: ciSnapshot?.failingChecks,
                    ciSnapshotComplete: ciSnapshot?.complete,
                    sourceType: "automation",
                  });
                console.log("GitHub feedback routed from check run", {
                  repoFullName,
                  prNumber,
                  checkRunId: checkRun.id,
                  conclusion: checkRun.conclusion,
                  signalOutcome,
                  enrolledWorkflowCount: activeWorkflows.length,
                  enrolledLoopUserCount: enrolledLoopUserIds.length,
                  ciSnapshotComplete: ciSnapshot?.complete ?? null,
                  ciSnapshotFailingChecksCount:
                    ciSnapshot?.failingChecks.length ?? null,
                  routeUserId: routeUserId ?? null,
                  ...feedbackRoutingResult,
                });
              }),
            );
          }),
        );
      }
    }

    console.log(
      `Successfully updated check status for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    return;
  } catch (error) {
    console.error("Error handling check run event:", error);
    throw error;
  }
}

// Handle check suite events
export async function handleCheckSuiteEvent(
  event: CheckSuiteEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    const repoFullName = event.repository.full_name;
    const checkSuite = event.check_suite;
    // Get PRs associated with this check suite
    let prNumbers = checkSuite.pull_requests.map((pr) => pr.number);
    if (prNumbers.length === 0 && checkSuite.head_sha) {
      console.log(
        `Check suite ${checkSuite.id} has no associated PRs inline, resolving from SHA ${checkSuite.head_sha}`,
      );
      prNumbers = await resolvePrNumbersFromSha({
        repoFullName,
        headSha: checkSuite.head_sha,
        includeTerminal: true,
      });
    }
    if (prNumbers.length === 0) {
      console.log(
        `Check suite ${checkSuite.id} has no associated PRs after SHA fallback, skipping`,
      );
      return;
    }
    console.log(
      `Processing check suite ${event.action} for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    // Update each associated PR
    await Promise.all(
      prNumbers.map(async (prNumber) => {
        await updateGitHubPR({
          repoFullName,
          prNumber,
          createIfNotFound: false,
        });
      }),
    );

    if (event.action === "completed") {
      const signalOutcome = getCheckSignalOutcome(checkSuite.conclusion);
      if (signalOutcome) {
        const ciSnapshot = await fetchCiSignalSnapshotForHeadSha({
          repoFullName,
          headSha: checkSuite.head_sha ?? null,
        });
        const failureDetails =
          signalOutcome === "fail"
            ? getCheckSuiteFailureDetails(checkSuite)
            : undefined;

        await Promise.all(
          prNumbers.map(async (prNumber) => {
            const matchedWorkflows = await getActiveWorkflowForGithubPR({
              db,
              repoFullName,
              prNumber,
              includeTerminal: true,
            });
            const { active: activeWorkflows, terminal: terminalWorkflows } =
              splitWorkflowsByTerminality(matchedWorkflows);
            const v3CiEvent: LoopEvent =
              signalOutcome === "pass"
                ? {
                    type: "gate_ci_passed",
                    runId: String(checkSuite.id),
                    headSha: checkSuite.head_sha ?? null,
                  }
                : {
                    type: "gate_ci_failed",
                    runId: String(checkSuite.id),
                    headSha: checkSuite.head_sha ?? null,
                    reason: failureDetails ?? "CI checks failed",
                  };
            await appendV3EventForWorkflowIds({
              workflowIds: activeWorkflows.map((workflow) => workflow.id),
              deliveryId,
              idempotencyScope: `check_suite.completed:${repoFullName}:${prNumber}:${checkSuite.id}:${signalOutcome}`,
              event: v3CiEvent,
            });
            // CI failure on a terminated thread's PR — resurrect so the agent
            // can triage. Passes don't warrant waking a terminal thread.
            if (signalOutcome === "fail") {
              await emitWorkflowResurrectedForTerminals({
                terminalWorkflows,
                deliveryId,
                cause: "check_failure",
                reason: failureDetails ?? "CI checks failed",
                scopeSuffix: `${repoFullName}:${prNumber}:${checkSuite.id}`,
              });
            }

            const enrolledLoopUserIds =
              getUniqueUserIdsFromActiveLoops(matchedWorkflows);
            const routeUserIds = getRouteUserIdsForCheckSignal({
              enrolledLoopUserIds,
              signalOutcome,
            });

            if (routeUserIds.length === 0) {
              return;
            }

            await Promise.all(
              routeUserIds.map(async (routeUserId) => {
                const feedbackRoutingResult =
                  await routeGithubFeedbackOrSpawnThread({
                    userId: routeUserId ?? undefined,
                    repoFullName,
                    prNumber,
                    eventType: "check_suite.completed",
                    deliveryId,
                    checkOutcome: signalOutcome,
                    headSha: checkSuite.head_sha ?? undefined,
                    checkSummary: `Check suite (${checkSuite.status}:${signalOutcome})`,
                    failureDetails,
                    checkSuiteId: checkSuite.id,
                    ciSnapshotSource: ciSnapshot
                      ? "github_check_runs"
                      : undefined,
                    ciSnapshotCheckNames: ciSnapshot?.checkNames,
                    ciSnapshotFailingChecks: ciSnapshot?.failingChecks,
                    ciSnapshotComplete: ciSnapshot?.complete,
                    sourceType: "automation",
                  });
                console.log("GitHub feedback routed from check suite", {
                  repoFullName,
                  prNumber,
                  checkSuiteId: checkSuite.id,
                  conclusion: checkSuite.conclusion,
                  signalOutcome,
                  enrolledWorkflowCount: activeWorkflows.length,
                  enrolledLoopUserCount: enrolledLoopUserIds.length,
                  ciSnapshotComplete: ciSnapshot?.complete ?? null,
                  ciSnapshotFailingChecksCount:
                    ciSnapshot?.failingChecks.length ?? null,
                  routeUserId: routeUserId ?? null,
                  ...feedbackRoutingResult,
                });
              }),
            );
          }),
        );
      }
    }

    console.log(
      `Successfully updated check status for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    return;
  } catch (error) {
    console.error("Error handling check suite event:", error);
    throw error;
  }
}

// Handle issue events
export async function handleIssueEvent(event: IssueEvent): Promise<void> {
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;
  console.log(
    `Issue event: ${event.action} for issue #${issueNumber} in ${repoFullName}`,
  );
  try {
    // Get all issue automations for this repository
    const automations = await getIssueAutomationsForRepo({
      db,
      repoFullName,
    });
    if (automations.length === 0) {
      return;
    }
    console.log(
      `Found ${automations.length} issue automations for ${repoFullName}`,
    );
    // Process each automation
    for (let i = 0; i < automations.length; i += BATCH_SIZE) {
      const batch = automations.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((automation) => handleIssueAutomation(event, automation)),
      );
      const failed = results.filter((result) => result.status === "rejected");
      const succeeded = results.filter(
        (result) => result.status === "fulfilled",
      );
      console.log(`Successfully handled ${succeeded.length} issue automations`);
      if (failed.length > 0) {
        console.error(
          `Error handling ${failed.length} issue automations: ${failed.map((result) => result.reason).join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error("Error handling issue event:", error);
  }
}

async function handleIssueAutomation(
  event: IssueEvent,
  automation: Automation,
): Promise<void> {
  const issueNumber = event.issue.number;
  const repoFullName = event.repository.full_name;
  if (automation.repoFullName !== repoFullName) {
    return;
  }
  const config = automation.triggerConfig as IssueTriggerConfig;
  // Check if this automation should trigger for the current event
  let shouldTrigger = false;
  switch (event.action) {
    case "opened": {
      shouldTrigger = !!config.on.open;
      break;
    }
    default: {
      shouldTrigger = false;
    }
  }
  if (!shouldTrigger) {
    console.log(
      `Automation ${automation.id} not configured to trigger on ${event.action}`,
    );
    return;
  }
  const issueAuthorUserName = event.issue.user?.login;
  const isIssueAuthor = await getIsIssueAuthor({
    userId: automation.userId,
    repoFullName,
    issueNumber,
  });

  let authorMatches = isIssueAuthor;
  if (
    !authorMatches &&
    config.filter.includeOtherAuthors &&
    issueAuthorUserName &&
    config.filter.otherAuthors
  ) {
    const allowedAuthors = config.filter.otherAuthors
      .split(",")
      .map((author) => author.trim().toLowerCase());
    if (allowedAuthors.includes(issueAuthorUserName.toLowerCase())) {
      authorMatches = true;
    }
  }
  if (!authorMatches) {
    console.log(
      `Skipping automation ${automation.id} - Issue author ${issueAuthorUserName} not in allowed list`,
    );
    return;
  }
  console.log(
    `Triggering automation ${automation.id} for issue #${issueNumber} in ${repoFullName} (${event.action})`,
  );
  await runIssueAutomation({
    automationId: automation.id,
    userId: automation.userId,
    issueEventAction: event.action,
    repoFullName,
    issueNumber,
    source: "automated",
  }).catch((error) => {
    console.error(
      `Error running automation ${automation.id} for issue #${issueNumber} in ${repoFullName}:`,
      error,
    );
  });
}
