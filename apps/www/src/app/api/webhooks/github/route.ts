/*
 * GitHub Webhook Handler for Pull Request Status Updates and App Mentions
 *
 * GitHub App Setup:
 * 1. Go to Settings → Developer settings → GitHub Apps → Select your app
 *
 * 2. Configure Webhook Settings:
 *    - Webhook URL: https://your-domain.com/api/webhooks/github
 *    - Webhook secret: Generate a secure secret and add to .env as GITHUB_WEBHOOK_SECRET
 *
 * 3. Subscribe to Events:
 *    - In "Permissions & events" section
 *    - Under "Subscribe to events", check: Pull requests, Issues, Issue comments, Pull request review comments, Pull request reviews, Check runs, Check suites
 *
 * 4. Set Required Permissions:
 *    - Repository permissions:
 *      • Pull requests: Read (minimum)
 *      • Issues: Read (to read PR comments)
 *      • Contents: Read (if you need to access code)
 *      • Actions: Read (for reruns and job logs)
 *      • Metadata: Read (always required)
 *
 * 5. Set environment variable:
 *    - NEXT_PUBLIC_GITHUB_APP_NAME: Your GitHub app name for mention detection
 *
 * 6. Save changes and install the app on target repositories
 *
 * This handler processes:
 * - PR actions: opened, closed, reopened, ready_for_review, converted_to_draft
 * - Issue comments: Creates follow-up tasks when the app is mentioned in PR comments
 * - PR review comments: Creates follow-up tasks when the app is mentioned in PR review comments
 * - PR reviews: Creates follow-up tasks when the app is mentioned in PR reviews
 * - Check runs: Updates PR check status when checks are created, completed, or rerequested
 * - Check suites: Updates PR check status when check suites are completed or rerequested
 */

import { Webhooks } from "@octokit/webhooks";
import { env } from "@terragon/env/apps-www";
import * as schema from "@terragon/shared/db/schema";
import { randomUUID } from "crypto";
import { and, eq, isNull, lte } from "drizzle-orm";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  handleCheckRunEvent,
  handleCheckSuiteEvent,
  handleIssueCommentEvent,
  handleIssueEvent,
  handlePullRequestReviewCommentEvent,
  handlePullRequestReviewEvent,
  handlePullRequestStatusChange,
  handlePullRequestUpdated,
} from "./handlers";
import {
  getShadowRefreshWebhookEvent,
  shadowRefreshGitHubProjectionsForWebhook,
} from "./shadow-refresh";

type SupportedGitHubWebhookName =
  | "pull_request"
  | "issue_comment"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "check_run"
  | "check_suite"
  | "issues";

const supportedGitHubWebhookNames = new Set<string>([
  "pull_request",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
  "issues",
]);

type GitHubWebhookClaimOutcome =
  | "claimed_new"
  | "stale_stolen"
  | "already_completed"
  | "in_progress_fresh";

type GitHubWebhookClaim = {
  shouldProcess: boolean;
  outcome: GitHubWebhookClaimOutcome;
};

const GITHUB_WEBHOOK_CLAIM_TTL_MS = 5 * 60 * 1000;

function getGithubWebhookClaimHttpStatus(
  outcome: GitHubWebhookClaimOutcome,
): number {
  switch (outcome) {
    case "claimed_new":
    case "stale_stolen":
    case "in_progress_fresh":
      return 202;
    case "already_completed":
      return 200;
  }
}

async function claimGithubWebhookDelivery(params: {
  deliveryId: string;
  claimantToken: string;
  eventType: string;
}): Promise<GitHubWebhookClaim> {
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + GITHUB_WEBHOOK_CLAIM_TTL_MS);
  const inserted = await db
    .insert(schema.githubWebhookDeliveries)
    .values({
      deliveryId: params.deliveryId,
      claimantToken: params.claimantToken,
      claimExpiresAt,
      eventType: params.eventType,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  if (inserted.length > 0) {
    return { shouldProcess: true, outcome: "claimed_new" };
  }

  const [existing] = await db
    .select({
      claimantToken: schema.githubWebhookDeliveries.claimantToken,
      claimExpiresAt: schema.githubWebhookDeliveries.claimExpiresAt,
      completedAt: schema.githubWebhookDeliveries.completedAt,
    })
    .from(schema.githubWebhookDeliveries)
    .where(eq(schema.githubWebhookDeliveries.deliveryId, params.deliveryId))
    .limit(1);

  if (!existing) {
    return claimGithubWebhookDelivery(params);
  }
  if (existing.completedAt) {
    return { shouldProcess: false, outcome: "already_completed" };
  }
  if (existing.claimExpiresAt.getTime() > now.getTime()) {
    return { shouldProcess: false, outcome: "in_progress_fresh" };
  }

  const stolen = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      claimantToken: params.claimantToken,
      claimExpiresAt,
      eventType: params.eventType,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, params.deliveryId),
        eq(
          schema.githubWebhookDeliveries.claimantToken,
          existing.claimantToken,
        ),
        eq(
          schema.githubWebhookDeliveries.claimExpiresAt,
          existing.claimExpiresAt,
        ),
        isNull(schema.githubWebhookDeliveries.completedAt),
        lte(schema.githubWebhookDeliveries.claimExpiresAt, now),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });
  if (stolen.length > 0) {
    return { shouldProcess: true, outcome: "stale_stolen" };
  }

  return claimGithubWebhookDelivery(params);
}

async function completeGithubWebhookDelivery(params: {
  deliveryId: string;
  claimantToken: string;
}): Promise<boolean> {
  const completed = await db
    .update(schema.githubWebhookDeliveries)
    .set({ completedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, params.deliveryId),
        eq(schema.githubWebhookDeliveries.claimantToken, params.claimantToken),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });
  return completed.length > 0;
}

async function releaseGithubWebhookDeliveryClaim(params: {
  deliveryId: string;
  claimantToken: string;
}): Promise<void> {
  await db
    .delete(schema.githubWebhookDeliveries)
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, params.deliveryId),
        eq(schema.githubWebhookDeliveries.claimantToken, params.claimantToken),
        isNull(schema.githubWebhookDeliveries.completedAt),
      ),
    );
}

function isSupportedGitHubWebhookName(
  name: string,
): name is SupportedGitHubWebhookName {
  return supportedGitHubWebhookNames.has(name);
}

export async function POST(request: NextRequest) {
  const webhooks = new Webhooks({
    secret: env.GITHUB_WEBHOOK_SECRET,
  });
  const [headersList, body] = await Promise.all([headers(), request.text()]);
  const signature = headersList.get("x-hub-signature-256") ?? "";
  const eventType = headersList.get("x-github-event") ?? "";
  const requestId = headersList.get("x-github-delivery") ?? "";
  let parsedPayload: unknown = null;
  let ownedClaim: {
    deliveryId: string;
    claimantToken: string;
    claimOutcome: GitHubWebhookClaimOutcome;
  } | null = null;
  try {
    parsedPayload = JSON.parse(body);
  } catch {
    // Let webhook verification surface malformed JSON when needed.
  }
  webhooks.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.closed",
      "pull_request.ready_for_review",
      "pull_request.converted_to_draft",
      "pull_request.synchronize",
    ],
    async ({ payload }) => {
      switch (payload.action) {
        case "opened":
        case "reopened":
        case "closed":
        case "ready_for_review":
        case "converted_to_draft": {
          await handlePullRequestStatusChange(payload, requestId);
          break;
        }
        default:
      }
      switch (payload.action) {
        case "opened":
        case "ready_for_review":
        case "synchronize": {
          await handlePullRequestUpdated(payload);
          break;
        }
        default:
      }
    },
  );
  webhooks.on("issue_comment.created", async ({ payload }) => {
    await handleIssueCommentEvent(payload, requestId);
  });
  webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    await handlePullRequestReviewEvent(payload, requestId);
  });
  webhooks.on("pull_request_review_comment.created", async ({ payload }) => {
    await handlePullRequestReviewCommentEvent(payload, requestId);
  });
  webhooks.on(
    ["check_run.completed", "check_run.created", "check_run.rerequested"],
    async ({ payload }) => {
      await handleCheckRunEvent(payload, requestId);
    },
  );
  webhooks.on(
    ["check_suite.completed", "check_suite.rerequested"],
    async ({ payload }) => {
      await handleCheckSuiteEvent(payload, requestId);
    },
  );
  webhooks.on(["issues.opened"], async ({ payload }) => {
    await handleIssueEvent(payload);
  });
  webhooks.onAny(({ name, payload }) => {
    const payloadInfo: string[] = [];
    if ("action" in payload) {
      payloadInfo.push(`action: ${payload.action}`);
    }
    if ("repository" in payload && payload.repository) {
      payloadInfo.push(`repository: ${payload.repository.full_name}`);
    }

    console.log("[github webhook] event received", name, ...payloadInfo);
  });
  webhooks.onError((error) => {
    console.error("[github webhook] error", error);
  });
  try {
    const isValid = await webhooks.verify(body, signature);
    if (!isValid) {
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }

    if (!requestId) {
      return NextResponse.json(
        { success: false, error: "Missing GitHub delivery ID" },
        { status: 400 },
      );
    }

    // Drop webhooks triggered by Terragon's own GitHub App bot. Without this,
    // our own pushes / PR comments / synchronize events would wake the agent
    // in an infinite loop. Third-party bots (dependabot, renovate) still go
    // through — only our own app login is hard-dropped.
    const ownBotLogin = `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`.toLowerCase();
    try {
      const parsedPayload = JSON.parse(body) as {
        sender?: { login?: string | null } | null;
      };
      const senderLogin = parsedPayload.sender?.login?.toLowerCase();
      if (senderLogin && senderLogin === ownBotLogin) {
        console.log("[github webhook] skipping webhook from own bot", {
          deliveryId: requestId,
          eventType,
          senderLogin,
        });
        return NextResponse.json(
          { success: true, skipped: "own-bot" },
          { status: 200 },
        );
      }
    } catch {
      // Malformed payload — let verify/receive below surface the real error.
    }

    const shadowRefreshEvent = getShadowRefreshWebhookEvent(
      eventType,
      parsedPayload,
    );

    const claimantToken = `github-webhook:${randomUUID()}`;
    const claim = await claimGithubWebhookDelivery({
      deliveryId: requestId,
      claimantToken,
      eventType,
    });

    if (!claim.shouldProcess) {
      return NextResponse.json(
        {
          success: true,
          claimOutcome: claim.outcome,
        },
        { status: getGithubWebhookClaimHttpStatus(claim.outcome) },
      );
    }
    ownedClaim = {
      deliveryId: requestId,
      claimantToken,
      claimOutcome: claim.outcome,
    };

    if (shadowRefreshEvent) {
      await shadowRefreshGitHubProjectionsForWebhook(shadowRefreshEvent);
    }

    if (
      parsedPayload === null ||
      typeof parsedPayload !== "object" ||
      Array.isArray(parsedPayload)
    ) {
      throw new Error("Invalid GitHub webhook payload");
    }

    if (!isSupportedGitHubWebhookName(eventType)) {
      throw new Error(`Unsupported GitHub webhook event: ${eventType}`);
    }

    await webhooks.receive({
      id: requestId,
      name: eventType,
      payload: JSON.parse(body),
    });

    const completed = await completeGithubWebhookDelivery({
      deliveryId: requestId,
      claimantToken,
    });
    if (!completed) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to complete GitHub webhook delivery claim",
          claimOutcome: ownedClaim.claimOutcome,
        },
        { status: 500 },
      );
    }
    const claimOutcome = ownedClaim.claimOutcome;
    ownedClaim = null;

    return NextResponse.json(
      {
        success: true,
        claimOutcome,
      },
      { status: getGithubWebhookClaimHttpStatus(claimOutcome) },
    );
  } catch (error) {
    if (ownedClaim) {
      await releaseGithubWebhookDeliveryClaim(ownedClaim).catch(
        (releaseError) => {
          console.error(
            "[github webhook] error releasing delivery claim",
            releaseError,
          );
        },
      );
    }
    console.error("[github webhook] error", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
