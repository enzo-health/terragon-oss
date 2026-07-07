import { WebClient } from "@slack/web-api";
import { db } from "@/lib/db";
import { getDefaultModel } from "@/lib/default-ai-model";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import type {
  SlackAccount,
  SlackInstallation,
  SlackSettings,
} from "@terragon/shared";
import {
  completeSlackTaskDelivery,
  getSlackAccountForSlackUserId,
  getSlackInstallationForTeam,
  getSlackSettingsForTeam,
  getSlackThreadLinkByThreadId,
  upsertSlackThreadLink,
} from "@terragon/shared/model/slack";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getThreadBySlackMessageKey } from "@terragon/shared/model/threads";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { decryptValue } from "@terragon/utils/encryption";
import type { SlackAppMentionEvent } from "@/server-lib/slack/slack-events";

export interface ResolvedSlackMentionContext {
  teamId: string;
  threadTs: string;
  slack: WebClient;
  slackBotToken: string;
  slackAccount: SlackAccount;
  slackInstallation: SlackInstallation;
  slackSettings: SlackSettings & { defaultRepoFullName: string };
  slackLiveSessionsEnabled: boolean;
  slackAttachmentsEnabled: boolean;
}

export async function resolveSlackMentionContext({
  event,
}: {
  event: SlackAppMentionEvent;
}): Promise<ResolvedSlackMentionContext | null> {
  const teamId = event.team;
  if (!teamId) {
    console.error("[slack webhook] No team ID in app mention event");
    return null;
  }
  if (!event.ts) {
    console.error("[slack webhook] No message timestamp in app mention event");
    return null;
  }

  const threadTs = event.thread_ts || event.ts;
  const slackUserId = event.user;
  const [slackInstallation, slackAccount] = await Promise.all([
    getSlackInstallationForTeam({ db, teamId }),
    getSlackAccountForSlackUserId({ db, teamId, slackUserId }),
  ]);
  if (!slackInstallation) {
    console.error(
      `[slack webhook] No Slack installation found for team ${teamId}`,
    );
    return null;
  }

  const slackBotToken = decryptValue(
    slackInstallation.botAccessTokenEncrypted,
    env.ENCRYPTION_MASTER_KEY,
  );
  const slack = new WebClient(slackBotToken);

  if (!slackAccount) {
    console.error(
      `[slack webhook] No Slack account found for user ${slackUserId} in team ${teamId}`,
    );
    await sendSetupMessage({
      slack,
      event,
      threadTs,
      teamId,
      message: `Hi <@${event.user}>! It looks like we're not connected yet. Please connect your Slack account in the <${publicAppUrl()}/settings|settings page>, then click "Try Again" below.`,
    });
    return null;
  }

  const slackSettings = await getSlackSettingsForTeam({
    db,
    userId: slackAccount.userId,
    teamId,
  });
  if (!slackSettings) {
    console.error(
      `[slack webhook] No Slack settings found for user ${slackAccount.userId} in team ${teamId}`,
    );
    await sendSetupMessage({
      slack,
      event,
      threadTs,
      teamId,
      message: `Hi <@${event.user}>! It looks like we're not set up yet. Please set up your Slack account in the <${publicAppUrl()}/settings/integrations|settings page>, then click "Try Again" below.`,
    });
    return null;
  }
  if (!slackSettings.defaultRepoFullName) {
    console.error(
      `[slack webhook] No default repository found for user ${slackAccount.userId} in team ${teamId}`,
    );
    await sendSetupMessage({
      slack,
      event,
      threadTs,
      teamId,
      message: `Hi <@${event.user}>! It looks like we're not set up yet. Please select a default repository in the <${publicAppUrl()}/settings/integrations|settings page>, then click "Try Again" below.`,
    });
    return null;
  }

  const [slackLiveSessionsEnabled, slackAttachmentsEnabled] = await Promise.all(
    [
      getFeatureFlagForUser({
        db,
        userId: slackAccount.userId,
        flagName: "slackLiveSessionsEnabled",
      }),
      getFeatureFlagForUser({
        db,
        userId: slackAccount.userId,
        flagName: "slackAttachmentsEnabled",
      }),
    ],
  );

  return {
    teamId,
    threadTs,
    slack,
    slackBotToken,
    slackAccount,
    slackInstallation,
    slackSettings: slackSettings as SlackSettings & {
      defaultRepoFullName: string;
    },
    slackLiveSessionsEnabled,
    slackAttachmentsEnabled,
  };
}

async function sendSetupMessage({
  slack,
  event,
  threadTs,
  teamId,
  message,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
  threadTs: string;
  teamId: string;
  message: string;
}): Promise<void> {
  const retryData = JSON.stringify({
    text: event.text,
    ts: event.ts,
    channel: event.channel,
    user: event.user,
    thread_ts: threadTs,
    team: teamId,
  });

  await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: message,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Try Again",
              emoji: true,
            },
            value: retryData,
            action_id: "retry_task_creation",
            style: "primary",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Go to Settings",
              emoji: true,
            },
            url: `${publicAppUrl()}/settings/integrations`,
            action_id: "go_to_settings",
          },
        ],
      },
    ],
  });
}

export async function ensureSlackThreadLinkForMention({
  slackAccount,
  slackInstallation,
  event,
  threadId,
  threadChatId,
}: {
  slackAccount: SlackAccount;
  slackInstallation: SlackInstallation;
  event: SlackAppMentionEvent;
  threadId: string;
  threadChatId: string | null | undefined;
}) {
  const threadTs = event.thread_ts || event.ts;
  return await upsertSlackThreadLink({
    db,
    link: {
      userId: slackAccount.userId,
      threadId,
      threadChatId,
      teamId: slackInstallation.teamId,
      enterpriseId: event.enterprise ?? slackInstallation.enterpriseId ?? null,
      isEnterpriseInstall: slackInstallation.isEnterpriseInstall,
      channelTeamId: event.channel_team ?? null,
      sourceTeamId: event.source_team ?? null,
      workspaceDomain: slackAccount.slackTeamDomain,
      channel: event.channel,
      rootMessageTs: threadTs,
      threadTs,
      origin: "slack-mention",
      mirrorMode: "status-and-final",
      collaborationMode: "same-team-linked-users",
      createdBySlackUserId: event.user,
      lastActorSlackUserId: event.user,
      slackContextJson: {
        slackEventId: event.slackEventId,
        messageTs: event.ts,
      },
    },
  });
}

export async function completeExistingSlackMentionTaskIfPresent({
  event,
  context,
}: {
  event: SlackAppMentionEvent;
  context: ResolvedSlackMentionContext;
}) {
  const existingThread = await getThreadBySlackMessageKey({
    db,
    userId: context.slackAccount.userId,
    teamId: context.teamId,
    workspaceDomain: context.slackAccount.slackTeamDomain,
    channel: event.channel,
    messageTs: event.ts,
  });
  if (!existingThread) {
    return false;
  }

  let slackThreadLinkId: string | undefined;
  if (
    context.slackLiveSessionsEnabled &&
    !(await getSlackThreadLinkByThreadId({
      db,
      threadId: existingThread.id,
    }))
  ) {
    const repairedLink = await ensureSlackThreadLinkForMention({
      slackAccount: context.slackAccount,
      slackInstallation: context.slackInstallation,
      event,
      threadId: existingThread.id,
      threadChatId: existingThread.threadChats[0]?.id,
    });
    slackThreadLinkId = repairedLink.id;
  }

  await completeSlackTaskDelivery({
    db,
    teamId: context.teamId,
    channel: event.channel,
    messageTs: event.ts,
    threadId: existingThread.id,
    threadChatId: existingThread.threadChats[0]?.id,
    slackThreadLinkId,
  });
  console.log("[slack webhook] Slack mention already has a task", {
    threadId: existingThread.id,
    teamId: context.teamId,
    channel: event.channel,
    messageTs: event.ts,
  });
  return true;
}

export async function resolveSlackMentionDefaultModel({
  slackAccount,
  slackSettings,
}: {
  slackAccount: SlackAccount;
  slackSettings: SlackSettings;
}) {
  if (slackSettings.defaultModel) {
    return slackSettings.defaultModel;
  }
  const [userFlags, userCredentials] = await Promise.all([
    getUserFlags({ db, userId: slackAccount.userId }),
    getUserCredentials({ userId: slackAccount.userId }),
  ]);
  return getDefaultModel({ userFlags, userCredentials });
}
