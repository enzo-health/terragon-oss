import { db } from "@/lib/db";
import {
  updateGitHubPR,
  getOctokitForApp,
  getIsPRAuthor,
  getIsIssueAuthor,
  parseRepoFullName,
} from "@/lib/github";
import {
  getGithubPR,
  getThreadsForGithubPR,
} from "@terragon/shared/model/github";
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
  getActiveSdlcLoopsForGithubPR,
  transitionActiveSdlcLoopsForGithubPREvent,
} from "@terragon/shared/model/sdlc-loop";
import {
  runPullRequestAutomation,
  runIssueAutomation,
} from "@/server-lib/automations";
import { Automation } from "@terragon/shared/db/types";
import { routeGithubFeedbackOrSpawnThread } from "./route-feedback";
import {
  convertToDraftOnceForUiGuard,
  withUiReadyGuard,
} from "@/server-lib/preview-validation";
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
  activeLoops: Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>,
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

async function syncSdlcLoopStateForPullRequestLifecycle({
  repoFullName,
  prNumber,
  action,
  merged,
}: {
  repoFullName: string;
  prNumber: number;
  action: string;
  merged?: boolean;
}) {
  const transitionEvent =
    action === "closed"
      ? merged
        ? "pr_merged"
        : "pr_closed_unmerged"
      : action === "opened" ||
          action === "ready_for_review" ||
          action === "reopened" ||
          action === "synchronize"
        ? "implementation_progress"
        : null;

  if (!transitionEvent) {
    return;
  }

  const transitionResult = await transitionActiveSdlcLoopsForGithubPREvent({
    db,
    repoFullName,
    prNumber,
    transitionEvent,
  });

  if (transitionResult.totalLoops > 0) {
    console.log("[github webhook] SDLC loop lifecycle transition applied", {
      repoFullName,
      prNumber,
      action,
      merged: merged ?? null,
      transitionEvent,
      ...transitionResult,
    });
  }
}

type CiSignalSnapshot = {
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

async function fetchCiSignalSnapshotForHeadSha({
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
        console.warn(
          "[github webhook] CI signal snapshot pagination incomplete",
          {
            repoFullName,
            headSha,
            totalCheckRunCount,
            fetchedCheckRunCount: allCheckRuns.length,
          },
        );
        return null;
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

async function fetchUnresolvedReviewThreadCount({
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
    // UI_READY_GUARD:webhookAutoReady
    if (
      (event.action === "ready_for_review" ||
        event.action === "synchronize" ||
        event.action === "reopened") &&
      !event.pull_request.draft
    ) {
      const matchingThreads = await getThreadsForGithubPR({
        db,
        repoFullName: repoName,
        prNumber,
      });
      if (matchingThreads.length > 0) {
        const [owner, repo] = parseRepoFullName(repoName);
        const octokit = await getOctokitForApp({ owner, repo });
        for (const threadRecord of matchingThreads) {
          if (threadRecord.archived) {
            continue;
          }
          await withUiReadyGuard({
            entrypoint: "webhookAutoReady",
            threadId: threadRecord.id,
            action: async () => undefined,
            onBlocked: async (decision) => {
              if (!decision.runId || !decision.threadChatId) {
                return;
              }
              await convertToDraftOnceForUiGuard({
                threadId: threadRecord.id,
                runId: decision.runId,
                threadChatId: decision.threadChatId,
                repoFullName: repoName,
                prNumber,
                octokit,
              });
            },
          });
        }
      }
    }
    await syncSdlcLoopStateForPullRequestLifecycle({
      repoFullName: repoName,
      prNumber,
      action: event.action,
      merged: event.pull_request.merged ?? undefined,
    });
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
    await syncSdlcLoopStateForPullRequestLifecycle({
      repoFullName,
      prNumber,
      action: event.action,
      merged: event.pull_request.merged ?? undefined,
    });

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
    // Check if the comment mentions our app
    if (!isAppMentioned(commentBody)) {
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
    const activeLoops = await getActiveSdlcLoopsForGithubPR({
      db,
      repoFullName,
      prNumber,
    });
    const enrolledLoopUserIds = getUniqueUserIdsFromActiveLoops(activeLoops);
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
                enrolledLoopCount: activeLoops.length,
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

    const activeLoops = await getActiveSdlcLoopsForGithubPR({
      db,
      repoFullName,
      prNumber,
    });
    const enrolledLoopUserIds = getUniqueUserIdsFromActiveLoops(activeLoops);
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
                enrolledLoopCount: activeLoops.length,
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

// Handle check run events
export async function handleCheckRunEvent(
  event: CheckRunEvent,
  deliveryId?: string,
): Promise<void> {
  try {
    const repoFullName = event.repository.full_name;
    const checkRun = event.check_run;
    const prNumbers = checkRun.pull_requests.map((pr) => pr.number);
    if (prNumbers.length === 0) {
      console.log(`Check run ${checkRun.id} has no associated PRs`);
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
            const activeLoops = await getActiveSdlcLoopsForGithubPR({
              db,
              repoFullName,
              prNumber,
            });
            const enrolledLoopUserIds =
              getUniqueUserIdsFromActiveLoops(activeLoops);
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
                  enrolledLoopCount: activeLoops.length,
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
    const prNumbers = checkSuite.pull_requests.map((pr) => pr.number);
    if (prNumbers.length === 0) {
      console.log(`Check suite ${checkSuite.id} has no associated PRs`);
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
            const activeLoops = await getActiveSdlcLoopsForGithubPR({
              db,
              repoFullName,
              prNumber,
            });
            const enrolledLoopUserIds =
              getUniqueUserIdsFromActiveLoops(activeLoops);
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
                  enrolledLoopCount: activeLoops.length,
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
