"use server";

import { env } from "@leo/env/apps-www";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  deleteSlackAccount,
  upsertSlackSettings,
} from "@leo/shared/model/slack";
import { encryptValue } from "@leo/utils/encryption";
import { SlackSettingsInsert } from "@leo/shared/db/types";

const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "users:read",
  "users:read.email",
  "channels:history",
  "files:read",
  "files:write",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "reactions:read",
  "reactions:write",
  "team:read",
  "channels:read",
  "groups:read",
  "mpim:read",
];
const SLACK_OPENID_SCOPES = ["openid", "profile", "email"];

// Used to install the Slack app
export const getSlackAppInstallUrl = userOnlyAction(
  async function getSlackAppInstallUrl(userId: string): Promise<string> {
    if (!env.SLACK_CLIENT_ID) {
      throw new Error("Slack OAuth is not configured");
    }
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`;
    const scopes = SLACK_BOT_SCOPES.join(",");
    const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
    slackAuthUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    slackAuthUrl.searchParams.set("scope", scopes);
    slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
    // Add state parameter with user ID for security
    const state = encryptValue(
      JSON.stringify({
        userId,
        timestamp: Date.now(),
        type: "app_install",
      }),
      env.ENCRYPTION_MASTER_KEY,
    );
    slackAuthUrl.searchParams.set("state", state);
    return slackAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Slack app install URL" },
);

// Used to connect to a users
export const getSlackOAuthUrl = userOnlyAction(
  async function getSlackOAuthUrl(userId: string): Promise<string> {
    if (!env.SLACK_CLIENT_ID) {
      throw new Error("Slack OAuth is not configured");
    }
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`;
    const slackAuthUrl = new URL("https://slack.com/openid/connect/authorize");
    slackAuthUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    slackAuthUrl.searchParams.set("scope", SLACK_OPENID_SCOPES.join(","));
    slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
    slackAuthUrl.searchParams.set("response_type", "code");

    // Add state parameter with user ID for security
    const state = encryptValue(
      JSON.stringify({
        userId,
        timestamp: Date.now(),
        type: "openid",
      }),
      env.ENCRYPTION_MASTER_KEY,
    );
    slackAuthUrl.searchParams.set("state", state);
    return slackAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Slack OAuth URL" },
);

export const disconnectSlackAccount = userOnlyAction(
  async function disconnectSlackAccount(
    userId: string,
    { teamId }: { teamId: string },
  ): Promise<void> {
    await deleteSlackAccount({ db, userId, teamId });
  },
  { defaultErrorMessage: "Failed to disconnect Slack account" },
);

export const updateSlackSettings = userOnlyAction(
  async function updateSlackSettings(
    userId: string,
    {
      teamId,
      settings,
    }: {
      teamId: string;
      settings: Omit<SlackSettingsInsert, "userId" | "teamId">;
    },
  ): Promise<void> {
    await upsertSlackSettings({ db, userId, teamId, settings });
  },
  { defaultErrorMessage: "Failed to update Slack settings" },
);
