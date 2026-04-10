import { db } from "@/lib/db";
import { getThreadMinimal, getThreadChat } from "@leo/shared/model/threads";
import {
  upsertClaudeSessionCheckpoint,
  getClaudeSessionCheckpoint,
} from "@leo/shared/model/claude-session";
import { uploadClaudeSessionToR2 } from "@/lib/r2-file-upload-server";
import { getR2ClientForFileUploadType } from "./r2-file-upload";
import { ISandboxSession } from "@leo/sandbox/types";
import { withThreadSandboxSession } from "@/agent/thread-resource";
import { getRawJSONLOrNullFromSandbox } from "./claude-session-internal";

function parseJSONLOrNull(
  jsonlOrNull: string | null | undefined,
): any[] | null {
  let jsonlParsed: any = null;
  try {
    if (jsonlOrNull) {
      const lines = jsonlOrNull.split("\n");
      jsonlParsed = lines
        .map((line: string) => {
          if (line) {
            return JSON.parse(line);
          }
          return null;
        })
        .filter(Boolean);
    }
  } catch (error) {
    console.error("Error parsing JSONL", error);
  }
  return jsonlParsed;
}

export type JSONLResult = {
  sessionId: string;
  contents: string;
};

export async function getClaudeSessionJSONLOrNull({
  userId,
  threadId,
  threadChatId,
  session,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  session: ISandboxSession | null;
}) {
  // Always try to get the session from R2 first
  const jsonlOrNull = await getClaudeSessionFromR2({
    userId,
    threadId,
    threadChatId,
  });
  if (jsonlOrNull) {
    return parseJSONLOrNull(jsonlOrNull);
  }
  // This is a bit gross but in some contexts, we already have a sandbox session
  // and in others, we don't. in the latter case, we need to get the session from
  // the sandbox.
  let resultOrNull: JSONLResult | null | undefined = null;
  if (session) {
    resultOrNull = await getRawJSONLOrNullFromSandbox({
      userId,
      threadId,
      threadChatId,
      session,
    });
  } else {
    resultOrNull = await withThreadSandboxSession({
      label: "getClaudeSessionJSONLOrNull",
      threadId,
      userId,
      threadChatId: null,
      execOrThrow: async ({ session }) => {
        if (!session) {
          return null;
        }
        return await getRawJSONLOrNullFromSandbox({
          userId,
          threadId,
          threadChatId,
          session,
        });
      },
    });
  }
  if (!resultOrNull) {
    return null;
  }
  // Always save the session to R2
  await saveClaudeSessionToR2({
    userId,
    threadId,
    sessionId: resultOrNull.sessionId,
    contents: resultOrNull.contents,
  });
  return parseJSONLOrNull(resultOrNull.contents);
}

async function getClaudeSessionFromR2({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat || !threadChat.sessionId) {
    return null;
  }
  // Try to get the session from R2
  console.log("Attempting to get Claude session from R2...");
  const checkpoint = await getClaudeSessionCheckpoint({
    db,
    userId,
    threadId,
    sessionId: threadChat.sessionId,
  });
  if (checkpoint) {
    try {
      const r2Key = checkpoint.r2Key;
      const r2Client = getR2ClientForFileUploadType("claudeSession");
      const sessionFileContents = await r2Client.downloadData(r2Key);
      console.log("Downloaded Claude session from R2", r2Key);
      return sessionFileContents.toString("utf-8");
    } catch (error) {
      console.error("Error downloading Claude session from R2", error);
      return null;
    }
  }
  return null;
}

async function saveClaudeSessionToR2({
  userId,
  threadId,
  sessionId,
  contents,
}: {
  userId: string;
  threadId: string;
  sessionId: string;
  contents: string;
}) {
  const thread = await getThreadMinimal({ db, threadId, userId });
  if (!thread) {
    console.error("Thread not found", { userId, threadId });
    return;
  }
  try {
    console.log("Attempting to upload Claude session to R2...");
    const r2Key = await uploadClaudeSessionToR2({
      userId,
      threadId,
      sessionId,
      contents,
    });
    await upsertClaudeSessionCheckpoint({
      db,
      userId,
      threadId,
      sessionId,
      r2Key,
    });
    console.log("Uploaded Claude session to R2", r2Key);
  } catch (error) {
    console.error("Error uploading Claude session to R2", error);
  }
}

export async function maybeSaveClaudeSessionToR2({
  userId,
  threadId,
  threadChatId,
  session,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  session: ISandboxSession;
}) {
  const resultOrNull = await getRawJSONLOrNullFromSandbox({
    userId,
    threadId,
    threadChatId,
    session,
  });
  if (!resultOrNull) {
    console.error("No JSONL found for thread", threadId);
    return;
  }
  await saveClaudeSessionToR2({
    userId,
    threadId,
    sessionId: resultOrNull.sessionId,
    contents: resultOrNull.contents,
  });
}
