import { db } from "@/lib/db";
import { ISandboxSession } from "@leo/sandbox/types";
import { getThreadChat } from "@leo/shared/model/threads";
import path from "path";
import { JSONLResult } from "./claude-session";

export async function getRawJSONLOrNullFromSandbox({
  userId,
  threadId,
  threadChatId,
  session,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  session: ISandboxSession;
}): Promise<JSONLResult | null> {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    return null;
  }
  if (threadChat.agent !== "claudeCode") {
    return null;
  }
  // Find the session file
  const claudeProjectName = ["-", session.homeDir, "-", session.repoDir].join(
    "",
  );
  const claudeSessionPath = path.join(
    "/",
    session.homeDir,
    ".claude/projects",
    claudeProjectName,
    `${threadChat.sessionId}.jsonl`,
  );
  try {
    const sessionFileContents = await session.readTextFile(claudeSessionPath);
    return {
      sessionId: threadChat.sessionId!,
      contents: sessionFileContents,
    };
  } catch (error) {
    console.error("Error reading session file", error);
    return null;
  }
}
