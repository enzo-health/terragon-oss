"use server";

import { adminOnly } from "@/lib/auth-server";
import { User } from "@leo/shared";
import { WebClient } from "@slack/web-api";
import { db } from "@/lib/db";
import { getSlackAccountAndInstallationForWorkspace } from "@leo/shared/model/slack";
import { decryptValue } from "@leo/utils/encryption";
import { env } from "@leo/env/apps-www";
import {
  buildSlackMentionMessage,
  SlackAppMentionEvent,
} from "@/app/api/webhooks/slack/handlers";

/**
 * Parse a Slack URL and extract channel, message ts, and thread ts
 * Example URL: https://workspace.slack.com/archives/C1234567890/p1234567890123456?thread_ts=1234567890.123456&cid=C1234567890
 */
function parseSlackMessageUrl(url: string): {
  workspaceDomain: string;
  channel: string;
  ts: string;
  threadTs?: string;
} | null {
  try {
    const urlObj = new URL(url);

    // Extract workspace domain (e.g., "workspace" from "workspace.slack.com")
    const hostnameParts = urlObj.hostname.split(".");
    if (hostnameParts.length < 3 || hostnameParts[1] !== "slack") {
      return null;
    }
    const workspaceDomain = hostnameParts[0];
    if (!workspaceDomain) {
      return null;
    }
    // Extract channel from path (e.g., /archives/C1234567890/p1234567890123456)
    const pathMatch = urlObj.pathname.match(/\/archives\/([^/]+)\/p(\d+)/);
    if (!pathMatch || pathMatch.length < 3) {
      return null;
    }

    const channel = pathMatch[1]!;
    const tsRaw = pathMatch[2]!;
    // Convert p1234567890123456 to 1234567890.123456
    const ts = `${tsRaw.slice(0, 10)}.${tsRaw.slice(10)}`;

    // Extract thread_ts from query params if present
    const threadTs = urlObj.searchParams.get("thread_ts") || undefined;
    return {
      workspaceDomain,
      channel,
      ts,
      threadTs,
    };
  } catch {
    return null;
  }
}

export const parseSlackUrl = adminOnly(async function parseSlackUrl(
  adminUser: User,
  url: string,
): Promise<
  { success: true; message: string } | { success: false; error: string }
> {
  // Parse the URL
  const parsed = parseSlackMessageUrl(url);
  if (!parsed) {
    return {
      success: false,
      error:
        "Invalid Slack URL format. Expected format: https://workspace.slack.com/archives/C.../p...",
    };
  }
  const { workspaceDomain, channel, ts, threadTs } = parsed;

  const { slackInstallation, slackAccount } =
    await getSlackAccountAndInstallationForWorkspace({
      db,
      userId: adminUser.id,
      workspaceDomain,
    });
  if (!slackInstallation) {
    return {
      success: false,
      error: `No Slack installation found for workspace: ${workspaceDomain}. Make sure the workspace is connected to Leo.`,
    };
  }
  if (!slackAccount) {
    return {
      success: false,
      error: `No Slack account found for workspace: ${workspaceDomain}. Make sure the workspace is connected to Leo.`,
    };
  }
  // Initialize Slack client
  const slack = new WebClient(
    decryptValue(
      slackInstallation.botAccessTokenEncrypted,
      env.ENCRYPTION_MASTER_KEY,
    ),
  );

  // Fetch the message
  let message;
  try {
    // If it's a threaded message, fetch the entire thread
    if (threadTs) {
      const result = await slack.conversations.replies({
        channel,
        ts: threadTs,
        inclusive: true,
        limit: 100,
      });

      if (!result.messages || result.messages.length === 0) {
        return {
          success: false,
          error: `No thread found at timestamp ${threadTs} in channel ${channel}. The bot may not be in this channel.`,
        };
      }

      // Find the specific message if it's not the thread parent
      if (threadTs !== ts) {
        message = result.messages.find((msg) => msg.ts === ts);
        if (!message) {
          return {
            success: false,
            error: `Message with timestamp ${ts} not found in thread ${threadTs}`,
          };
        }
      } else {
        message = result.messages[0]!;
      }
    } else {
      // This is a top-level message
      const result = await slack.conversations.history({
        channel,
        latest: ts,
        inclusive: true,
        limit: 1,
      });

      if (!result.messages || result.messages.length === 0) {
        return {
          success: false,
          error: `No message found at timestamp ${ts} in channel ${channel}. The bot may not be in this channel.`,
        };
      }

      message = result.messages[0]!;
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch message: ${error instanceof Error ? error.message : "Unknown error"}. Make sure the bot is in channel ${channel}.`,
    };
  }

  if (!message.user || !message.text) {
    return {
      success: false,
      error: "Message is missing user or text fields",
    };
  }

  // Build the event object
  const event: SlackAppMentionEvent = {
    type: "app_mention",
    user: message.user,
    text: message.text,
    ts,
    channel,
    thread_ts: threadTs,
    team: slackInstallation.teamId,
  };

  // Generate the output
  try {
    const output = await buildSlackMentionMessage({
      slackAccount,
      slack,
      event,
    });

    return {
      success: true,
      message: output,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to build message: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
});
