"use server";

import { db } from "@/lib/db";
import { adminOnly } from "@/lib/auth-server";
import { ThreadInfoFull, User } from "@leo/shared";
import { getUser } from "@leo/shared/model/user";
import { getThreadWithPermissions } from "@leo/shared/model/threads";
import { getClaudeSessionCheckpoint } from "@leo/shared/model/claude-session";
import { getR2ClientForFileUploadType } from "@/server-lib/r2-file-upload";

export type ThreadForAdmin = ThreadInfoFull & {
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export const getThreadForAdmin = adminOnly(async function getThreadForAdmin(
  adminUser: User,
  threadId: string,
) {
  console.log("getThreadForAdmin", threadId);
  const thread = await getThreadWithPermissions({
    db,
    threadId,
    userId: adminUser.id,
    allowAdmin: true,
  });
  if (!thread) {
    return undefined;
  }
  const user = await getUser({ db, userId: thread.userId });
  if (!user) {
    return undefined;
  }
  return {
    ...thread,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  };
});

export const downloadClaudeSessionJSONL = adminOnly(
  async function downloadClaudeSessionJSONL(
    adminUser: User,
    { threadId, sessionId }: { threadId: string; sessionId: string },
  ) {
    const thread = await getThreadWithPermissions({
      db,
      threadId,
      userId: adminUser.id,
      allowAdmin: true,
    });
    if (!thread) {
      throw new Error("Thread not found");
    }
    const checkpoint = await getClaudeSessionCheckpoint({
      db,
      userId: thread.userId,
      threadId,
      sessionId,
    });
    if (!checkpoint) {
      return null;
    }
    try {
      const r2Client = getR2ClientForFileUploadType("claudeSession");
      const sessionFileContents = await r2Client.downloadData(checkpoint.r2Key);
      return sessionFileContents.toString("utf-8");
    } catch (error) {
      console.error("Error downloading Claude session from R2", error);
      return null;
    }
  },
);
