/**
 * Slack DM sending utility.
 *
 * Opens a direct message channel with a Slack user and sends a message.
 * Uses the workspace bot token from the slackInstallation table.
 */

import { WebClient } from "@slack/web-api";
import { db } from "@/lib/db";
import { getSlackInstallationForTeam } from "@terragon/shared/model/slack";
import { decryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";

/**
 * Send a Slack DM to a user via the workspace bot.
 *
 * @param slackUserId - The Slack user ID to DM (e.g. "U01ABC123")
 * @param teamId - The Slack workspace/team ID (e.g. "T01ABC123")
 * @param text - Fallback plain text (shown in notifications)
 * @param blocks - Optional Slack Block Kit blocks for rich formatting
 */
export async function sendSlackDM({
  slackUserId,
  teamId,
  text,
  blocks,
}: {
  slackUserId: string;
  teamId: string;
  text: string;
  blocks?: Array<Record<string, unknown>>;
}): Promise<void> {
  // 1. Get the Slack installation for this workspace (has bot token)
  const installation = await getSlackInstallationForTeam({ db, teamId });
  if (!installation) {
    console.warn(
      `[slack-dm] No Slack installation found for team ${teamId}, skipping DM`,
    );
    return;
  }

  const botToken = decryptValue(
    installation.botAccessTokenEncrypted,
    env.ENCRYPTION_MASTER_KEY,
  );
  const slack = new WebClient(botToken);

  // 2. Open a DM channel with the user
  const conversationResult = await slack.conversations.open({
    users: slackUserId,
  });

  const channelId = conversationResult.channel?.id;
  if (!channelId) {
    console.error(
      `[slack-dm] Failed to open DM channel with Slack user ${slackUserId}`,
    );
    return;
  }

  // 3. Send the message
  await slack.chat.postMessage({
    channel: channelId,
    text,
    ...(blocks ? { blocks } : {}),
  });
}
