import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/apps-www";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { getThreadMinimal, updateThread } from "@terragon/shared/model/threads";
import { encryptValue } from "@terragon/utils/encryption";
import { db } from "@/lib/db";
import {
  emitSlackThreadErrorNotification,
  formatSlackThreadErrorBlocks,
  formatSlackThreadErrorNotification,
} from "./slack-agent-activity";

const slackMocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: {
      postMessage: slackMocks.postMessage,
    },
  })),
}));

vi.mock("@terragon/env/next-public", () => ({
  publicAppUrl: () => "https://terragon.example",
}));

describe("slack-agent-activity", () => {
  beforeEach(async () => {
    await db.delete(schema.slackOutboundDeliveries);
    await db.delete(schema.slackThreadLinks);
    await db.delete(schema.slackInstallation);
    slackMocks.postMessage.mockReset();
    slackMocks.postMessage.mockResolvedValue({ ok: true, ts: "1710000000.9" });
  });

  describe("formatSlackThreadErrorNotification", () => {
    it("renders Claude credential failures with actionable Slack copy", () => {
      expect(
        formatSlackThreadErrorNotification({
          threadId: "thread-123",
          errorType: "invalid-claude-credentials",
          errorInfo: "refresh token expired",
        }),
      ).toBe(
        [
          ":warning: Claude credentials expired",
          "",
          "Update your Claude credentials in Terragon settings, then retry the task.",
          "",
          "https://terragon.example/task/thread-123",
        ].join("\n"),
      );
    });

    it("sanitizes generic error details before posting to Slack", () => {
      expect(
        formatSlackThreadErrorNotification({
          threadId: "thread-123",
          errorType: "agent-generic-error",
          errorInfo: "line one\nline two",
        }),
      ).toContain("line one line two");
    });
  });

  describe("formatSlackThreadErrorBlocks", () => {
    it("renders a Block Kit alert with an Open task button", () => {
      expect(
        formatSlackThreadErrorBlocks({
          threadId: "thread-123",
          errorType: "invalid-claude-credentials",
          errorInfo: "refresh token expired",
        }),
      ).toEqual([
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":warning: *Claude credentials expired*",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Update your Claude credentials in Terragon settings, then retry the task.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Open task",
                emoji: true,
              },
              url: "https://terragon.example/task/thread-123",
              action_id: "open_failed_task",
              style: "primary",
            },
          ],
        },
      ]);
    });
  });

  describe("emitSlackThreadErrorNotification", () => {
    it("posts to the original Slack thread from source metadata and dedupes retries", async () => {
      const { user } = await createTestUser({ db });
      const teamId = "TTEAM123";
      const channel = "CCHAN123";
      const messageTs = "1710000000.000100";
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          sourceType: "slack-mention",
          sourceMetadata: {
            type: "slack-mention",
            teamId,
            slackEventId: "Ev123",
            workspaceDomain: "test-workspace",
            channel,
            messageTs,
          },
        },
      });
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Test Team",
        botUserId: "UBOT123",
        botAccessTokenEncrypted: encryptValue(
          "xoxb-test-token",
          env.ENCRYPTION_MASTER_KEY,
        ),
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });
      const thread = await getThreadMinimal({ db, userId: user.id, threadId });
      expect(thread).not.toBeNull();

      await emitSlackThreadErrorNotification({
        thread: thread!,
        threadId,
        threadChatId,
        errorType: "invalid-claude-credentials",
        errorInfo: "refresh token expired",
      });
      await emitSlackThreadErrorNotification({
        thread: thread!,
        threadId,
        threadChatId,
        errorType: "invalid-claude-credentials",
        errorInfo: "refresh token expired",
      });

      expect(slackMocks.postMessage).toHaveBeenCalledExactlyOnceWith({
        channel,
        thread_ts: messageTs,
        text: expect.stringContaining("Claude credentials expired"),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "actions",
            elements: expect.arrayContaining([
              expect.objectContaining({
                type: "button",
                text: expect.objectContaining({ text: "Open task" }),
                url: `https://terragon.example/task/${threadId}`,
              }),
            ]),
          }),
        ]),
      });
      const deliveries = await db
        .select()
        .from(schema.slackOutboundDeliveries)
        .where(eq(schema.slackOutboundDeliveries.threadId, threadId));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        slackThreadLinkId: null,
        threadId,
        threadChatId,
        teamId,
        channel,
        threadTs: messageTs,
        messageTs: "1710000000.9",
        kind: "error",
        status: "sent",
      });
    });
  });
});
