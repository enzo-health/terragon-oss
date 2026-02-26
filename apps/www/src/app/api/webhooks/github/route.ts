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

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import {
  handlePullRequestStatusChange,
  handleIssueCommentEvent,
  handlePullRequestReviewCommentEvent,
  handlePullRequestReviewEvent,
  handleCheckRunEvent,
  handleCheckSuiteEvent,
  handlePullRequestUpdated,
  handleIssueEvent,
} from "./handlers";
import { Webhooks } from "@octokit/webhooks";
import { env } from "@terragon/env/apps-www";
import { randomUUID } from "crypto";
import {
  claimGithubWebhookDelivery,
  completeGithubWebhookDelivery,
  getGithubWebhookClaimHttpStatus,
  releaseGithubWebhookDeliveryClaim,
} from "@terragon/shared/model/sdlc-loop";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const webhooks = new Webhooks({
    secret: env.GITHUB_WEBHOOK_SECRET,
  });
  const [headersList, body] = await Promise.all([headers(), request.text()]);
  const signature = headersList.get("x-hub-signature-256") ?? "";
  const eventType = headersList.get("x-github-event") ?? "";
  const requestId = headersList.get("x-github-delivery") ?? "";
  webhooks.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.closed",
      "pull_request.ready_for_review",
      "pull_request.converted_to_draft",
    ],
    async ({ payload }) => {
      await handlePullRequestStatusChange(payload);
    },
  );
  webhooks.on(
    [
      "pull_request.opened",
      "pull_request.ready_for_review",
      "pull_request.synchronize",
    ],
    async ({ payload }) => {
      await handlePullRequestUpdated(payload);
    },
  );
  webhooks.on("issue_comment.created", async ({ payload }) => {
    await handleIssueCommentEvent(payload);
  });
  webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    await handlePullRequestReviewEvent(payload);
  });
  webhooks.on("pull_request_review_comment.created", async ({ payload }) => {
    await handlePullRequestReviewCommentEvent(payload);
  });
  webhooks.on(
    ["check_run.completed", "check_run.created", "check_run.rerequested"],
    async ({ payload }) => {
      await handleCheckRunEvent(payload);
    },
  );
  webhooks.on(
    ["check_suite.completed", "check_suite.rerequested"],
    async ({ payload }) => {
      await handleCheckSuiteEvent(payload);
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

    const claimantToken = `github-webhook:${randomUUID()}`;
    const claim = await claimGithubWebhookDelivery({
      db,
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

    try {
      await webhooks.receive({
        id: requestId,
        name: eventType as any,
        payload: JSON.parse(body),
      });
    } catch (error) {
      try {
        const released = await releaseGithubWebhookDeliveryClaim({
          db,
          deliveryId: requestId,
          claimantToken,
        });
        if (!released) {
          console.warn(
            "[github webhook] failed to release delivery claim after receive error",
            {
              deliveryId: requestId,
              claimOutcome: claim.outcome,
            },
          );
        }
      } catch (releaseError) {
        console.error(
          "[github webhook] error releasing delivery claim after receive error",
          releaseError,
        );
      }
      throw error;
    }

    const completed = await completeGithubWebhookDelivery({
      db,
      deliveryId: requestId,
      claimantToken,
    });

    if (!completed) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to complete GitHub webhook delivery claim",
          claimOutcome: claim.outcome,
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        claimOutcome: claim.outcome,
      },
      { status: getGithubWebhookClaimHttpStatus(claim.outcome) },
    );
  } catch (error) {
    console.error("[github webhook] error", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
