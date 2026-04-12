/**
 * PR Review notification dispatcher.
 *
 * When an AI review completes, notifies all assigned reviewers via Slack DM.
 * Each reviewer's Slack account is looked up via the slackAccount table,
 * and the message is sent using the workspace bot token.
 */

import { db } from "@/lib/db";
import { getSlackAccounts } from "@terragon/shared/model/slack";
import { sendSlackDM } from "@/server-lib/slack-dm";
import { publicAppUrl } from "@terragon/env/next-public";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewCommentPriority = "high" | "medium" | "low";

export interface ReviewForNotification {
  id: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  repoFullName: string;
  authorLogin: string;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  riskLevel: string; // e.g. "HIGH", "MEDIUM", "LOW"
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export interface ReviewAssignment {
  id: string;
  userId: string; // Terragon user ID
  notifiedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function buildReviewNotificationText(review: ReviewForNotification): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const reviewUrl = `${publicAppUrl()}/review/${review.id}`;

  const summaryLine = [
    `by ${review.authorLogin}`,
    `+${review.linesAdded} -${review.linesRemoved}`,
    `${review.filesChanged} file${review.filesChanged !== 1 ? "s" : ""} changed`,
  ].join(" | ");

  const findingsLine = [
    review.highCount > 0 ? `${review.highCount} HIGH` : null,
    review.mediumCount > 0 ? `${review.mediumCount} MEDIUM` : null,
    review.lowCount > 0 ? `${review.lowCount} LOW` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const text = [
    `PR Review Ready: PR #${review.prNumber} \u2014 ${review.prTitle}`,
    summaryLine,
    `Risk Level: ${review.riskLevel} | ${findingsLine} findings`,
    reviewUrl,
  ].join("\n");

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `:mag: *PR Review Ready:* <${review.prUrl}|PR #${review.prNumber}> \u2014 ${review.prTitle}`,
          "",
          `by ${review.authorLogin} | +${review.linesAdded} -${review.linesRemoved} | ${review.filesChanged} file${review.filesChanged !== 1 ? "s" : ""} changed`,
          "",
          `*Risk Level:* ${review.riskLevel} | ${findingsLine} findings`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "View Review",
            emoji: true,
          },
          url: reviewUrl,
          action_id: "view_review",
          style: "primary",
        },
      ],
    },
  ];

  return { text, blocks };
}

// ---------------------------------------------------------------------------
// Main notification function
// ---------------------------------------------------------------------------

/**
 * Notify all assigned reviewers for a review via Slack DM.
 *
 * For each assignment:
 *  1. Look up the user's Slack account(s)
 *  2. Send a DM via the workspace bot
 *  3. Return the list of user IDs that were notified
 *
 * Errors for individual users are caught and logged; other users still get
 * notified. This function never throws.
 */
export async function notifyReviewersViaSlack({
  review,
  assignments,
}: {
  review: ReviewForNotification;
  assignments: ReviewAssignment[];
}): Promise<{ notifiedUserIds: string[] }> {
  const { text, blocks } = buildReviewNotificationText(review);
  const notifiedUserIds: string[] = [];

  for (const assignment of assignments) {
    // Skip already-notified assignments
    if (assignment.notifiedAt != null) {
      continue;
    }

    try {
      // Find the user's Slack account(s)
      const slackAccounts = await getSlackAccounts({
        db,
        userId: assignment.userId,
      });

      if (slackAccounts.length === 0) {
        console.warn(
          `[review-notifications] No Slack account found for user ${assignment.userId}, skipping`,
        );
        continue;
      }

      // Send DM to each linked Slack workspace
      for (const account of slackAccounts) {
        try {
          await sendSlackDM({
            slackUserId: account.slackUserId,
            teamId: account.teamId,
            text,
            blocks,
          });
          notifiedUserIds.push(assignment.userId);
        } catch (err) {
          console.error(
            `[review-notifications] Failed to send Slack DM to user ${assignment.userId} in team ${account.teamId}`,
            err,
          );
        }
      }
    } catch (err) {
      console.error(
        `[review-notifications] Error looking up Slack account for user ${assignment.userId}`,
        err,
      );
    }
  }

  return { notifiedUserIds };
}
