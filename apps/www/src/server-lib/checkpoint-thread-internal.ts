import { db } from "@/lib/db";
import { wrapError, ThreadError } from "@/agent/error";
import { openPullRequestForThread } from "@/agent/pull-request";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { getPostHogServer } from "@/lib/posthog-server";
import { env } from "@terragon/env/apps-www";
import {
  getGitDiffMaybeCutoff,
  gitDiffStats,
  gitCommitAndPushBranch,
} from "@terragon/sandbox/commands";
import { ISandboxSession } from "@terragon/sandbox/types";
import {
  DBUserMessage,
  DBMessage,
  DBSystemMessage,
  GitDiffStats,
  ThreadInsert,
  ThreadChatInsert,
} from "@terragon/shared";
import {
  getThread,
  getThreadChat,
  getThreadMinimal,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { createGitDiffCheckpoint } from "@terragon/shared/utils/git-diff";
import { sanitizeForJson } from "@terragon/shared/utils/sanitize-json";
import * as schema from "@terragon/shared/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { queueFollowUpInternal } from "./follow-up";
import { generateCommitMessage } from "./generate-commit-message";
import { sendSystemMessage } from "./send-system-message";

const DELIVERY_PLAN_TOOL_NAMES = {
  EXIT_PLAN_MODE: "ExitPlanMode",
  WRITE: "Write",
} as const;

function extractLatestTopLevelAgentText(
  messages: DBMessage[] | null,
): string | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  // Merge the last consecutive run of top-level agent messages.
  // ACP transports (e.g. Codex) stream word-by-word, so a single response
  // becomes many small agent messages that must be concatenated.
  const textParts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.type !== "agent" || message.parent_tool_use_id !== null) {
      if (textParts.length > 0) break; // end of consecutive run
      continue;
    }
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
    if (text.length > 0) {
      textParts.unshift(text); // prepend to maintain order
    }
  }

  return textParts.length > 0 ? textParts.join("") : null;
}

type PlanTextSource = "exit_plan_mode" | "write_tool" | "agent_text";

function findPlanFromWriteToolCall({
  messages,
  exitPlanModeToolId,
}: {
  messages: DBMessage[];
  exitPlanModeToolId: string;
}): string | null {
  let exitPlanModeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.type === "tool-call" &&
      message.name === DELIVERY_PLAN_TOOL_NAMES.EXIT_PLAN_MODE &&
      message.id === exitPlanModeToolId
    ) {
      exitPlanModeIndex = i;
      break;
    }
  }
  if (exitPlanModeIndex === -1) {
    return null;
  }

  for (let i = exitPlanModeIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.type === "user") {
      break;
    }
    if (
      message.type === "tool-call" &&
      message.name === DELIVERY_PLAN_TOOL_NAMES.WRITE
    ) {
      const filePath = message.parameters?.file_path;
      const content = message.parameters?.content;
      if (
        typeof filePath === "string" &&
        /plans\/[^/]+\.md$/.test(filePath) &&
        typeof content === "string" &&
        content.trim().length > 0
      ) {
        return content;
      }
    }
  }

  return null;
}

export function extractLatestPlanText(messages: DBMessage[] | null): {
  text: string;
  source: PlanTextSource;
} | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  // Priority 1: ExitPlanMode tool call (with optional Write companion)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      !message ||
      message.type !== "tool-call" ||
      message.name !== DELIVERY_PLAN_TOOL_NAMES.EXIT_PLAN_MODE
    ) {
      continue;
    }
    if (
      typeof message.parameters?.plan === "string" &&
      message.parameters.plan.trim().length > 0
    ) {
      return {
        text: message.parameters.plan.trim(),
        source: "exit_plan_mode",
      };
    }
    const writePlan = findPlanFromWriteToolCall({
      messages,
      exitPlanModeToolId: message.id,
    });
    if (writePlan) {
      return {
        text: writePlan.trim(),
        source: "write_tool",
      };
    }
  }

  // Priority 2: Standalone Write to plans/*.md (no ExitPlanMode required).
  // Enables ACP agents that can Write but cannot ExitPlanMode.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === "user") break;
    if (
      message.type === "tool-call" &&
      message.name === DELIVERY_PLAN_TOOL_NAMES.WRITE
    ) {
      const filePath = message.parameters?.file_path;
      const content = message.parameters?.content;
      if (
        typeof filePath === "string" &&
        /plans\/[^/]+\.md$/.test(filePath) &&
        typeof content === "string" &&
        content.trim().length > 0
      ) {
        return { text: content.trim(), source: "write_tool" };
      }
    }
  }

  // Priority 3: Agent text fallback
  const latestAgentText = extractLatestTopLevelAgentText(messages);
  if (!latestAgentText) {
    return null;
  }
  return {
    text: latestAgentText,
    source: "agent_text",
  };
}

/**
 * Detect whether the agent explicitly signaled phase completion via
 * `"phaseComplete": true` in a structured JSON block. Until this signal
 * appears, checkpoints are bookkeeping-only — no gate evaluation, no
 * follow-up messages, no loop.
 */
/** Pre-lowercased aliases for the phase-complete signal key. */
const PHASE_COMPLETE_ALIASES: ReadonlySet<string> = new Set([
  "phasecomplete",
  "phase_complete",
  "phasecompleted",
  "phase_completed",
  "isphasecomplete",
  "is_phase_complete",
]);

export function detectPhaseCompleteSignal(
  messages: DBMessage[] | null,
): boolean {
  const agentText = extractLatestTopLevelAgentText(messages);
  if (!agentText) return false;

  const trimmed = agentText.trim();
  const fencedJsonMatches = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const jsonCandidates = [trimmed, ...fencedJsonMatches.map((m) => m[1] ?? "")];

  for (const candidate of jsonCandidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const lowerKeys = new Map(
        Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]),
      );
      for (const alias of PHASE_COMPLETE_ALIASES) {
        if (lowerKeys.get(alias) === true) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function buildDeliveryFixFollowUpMessage({
  heading,
  details,
}: {
  heading: string;
  details: string[];
}): DBUserMessage {
  return {
    type: "user",
    model: null,
    timestamp: new Date().toISOString(),
    parts: [
      {
        type: "text",
        text: [heading, ...details].join("\n\n"),
      },
    ],
  };
}

export async function queueDeliveryFollowUpMessage({
  userId,
  threadId,
  threadChatId,
  heading,
  details,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  heading: string;
  details: string[];
}) {
  await queueFollowUpInternal({
    userId,
    threadId,
    threadChatId,
    messages: [
      buildDeliveryFixFollowUpMessage({
        heading,
        details,
      }),
    ],
    appendOrReplace: "append",
    source: "www",
  });
}

export function formatReviewFindings({
  label,
  findings,
}: {
  label: string;
  findings: Array<{
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    detail: string;
    category: string;
  }>;
}) {
  if (findings.length === 0) {
    return null;
  }
  return [
    `${label}:`,
    ...findings.slice(0, 8).map((finding, index) => {
      return `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title} (${finding.category})\n${finding.detail}`;
    }),
  ].join("\n");
}

export async function checkpointThreadAndPush({
  threadId,
  threadChatId,
  userId,
  session,
  createPR,
  prType,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
  session: ISandboxSession;
  createPR: boolean;
  prType: "draft" | "ready";
}) {
  const thread = await getThread({ db, threadId, userId });
  if (!thread) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }
  const getGitDiffOrThrow = async (): Promise<{
    diffOutput: string | null;
    diffStats: GitDiffStats | null;
  }> => {
    try {
      const diffOutput = await getGitDiffMaybeCutoff({
        session,
        baseBranch: thread.repoBaseBranchName,
        allowCutoff: false,
      });
      const diffStats = await gitDiffStats(session, {
        baseBranch: thread.repoBaseBranchName,
      });
      return { diffOutput: sanitizeForJson(diffOutput), diffStats };
    } catch (error) {
      console.error("Failed to get git diff:", error);
      throw wrapError("git-checkpoint-diff-failed", error);
    }
  };

  try {
    let commitAndPushError: unknown = null;
    const updates: Partial<ThreadInsert> = {};
    const chatUpdates: Omit<ThreadChatInsert, "threadChatId"> = {};
    try {
      // Commit changes and push
      const { branchName, errorMessage } = await gitCommitAndPushBranch({
        session,
        args: {
          githubAppName: env.NEXT_PUBLIC_GITHUB_APP_NAME,
          baseBranch: thread.repoBaseBranchName,
          generateCommitMessage: generateCommitMessage,
        },
      });
      if (errorMessage) {
        console.error("Failed at gitCommitAndPushBranch:", errorMessage);
        throw new ThreadError("git-checkpoint-push-failed", errorMessage, null);
      }
      if (branchName) {
        updates.branchName = branchName;
      }
    } catch (e) {
      // Keep this error for later, try to checkpoint a git diff anyway.
      commitAndPushError = wrapError("git-checkpoint-push-failed", e);
    }

    // Update git diff stats
    const { diffOutput, diffStats } = await getGitDiffOrThrow();
    updates.gitDiff = diffOutput;
    updates.gitDiffStats = diffStats;

    // Check if git diff has changed. We need to check the diff stats because
    // the diff output might be cutoff or simply "too-large".
    const diffOutputHasChanged =
      diffOutput === "too-large" ||
      diffOutput !== thread.gitDiff ||
      diffStats?.files !== thread.gitDiffStats?.files ||
      diffStats?.additions !== thread.gitDiffStats?.additions ||
      diffStats?.deletions !== thread.gitDiffStats?.deletions;
    if (diffOutput && diffOutputHasChanged) {
      // Create git diff checkpoint message
      const gitDiffMessage = createGitDiffCheckpoint({
        diff: diffOutput,
        diffStats,
      });
      chatUpdates.appendMessages = [gitDiffMessage];

      getPostHogServer().capture({
        distinctId: userId,
        event: "git_diff_changed",
        properties: {
          threadId,
          gitDiffSize: diffOutput.length,
          ...diffStats,
        },
      });
    }

    if (Object.keys(updates).length > 0) {
      await updateThread({
        db,
        userId,
        threadId,
        updates,
      });
    }
    if (Object.keys(chatUpdates).length > 0) {
      await updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId,
        updates: chatUpdates,
      });
    }

    if (commitAndPushError) {
      // If the error is a git commit and push error, we can try to auto-fix it.
      // If we can't auto-fix it, we'll throw the error.
      if (
        await maybeAutoFixGitCommitAndPushError({
          userId,
          threadId,
          threadChatId,
          error: commitAndPushError,
        })
      ) {
        return;
      }
      throw commitAndPushError;
    }

    // 1. Normal case: diffOutput exists and diff has changed
    // 2. After git retry: diffOutput exists but thread doesn't have a PR yet
    //    (handles the case where git push failed after diff was captured)
    if (
      diffOutput &&
      (diffOutputHasChanged || !thread.githubPRNumber) &&
      createPR
    ) {
      try {
        await openPullRequestForThread({
          userId,
          threadId,
          threadChatId,
          prType: prType,
          skipCommitAndPush: true,
          session,
        });
      } catch (e) {
        console.error("Failed to create PR:", e);
      }
    }
  } catch (e) {
    throw wrapError("git-checkpoint-push-failed", e);
  }
}

async function maybeAutoFixGitCommitAndPushError({
  userId,
  threadId,
  threadChatId,
  error,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  error: unknown;
}): Promise<boolean> {
  console.log("maybeAutoFixGitCommitAndPushError", {
    userId,
    threadId,
    threadChatId,
    error,
  });
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat || !threadChat.messages) {
    return false;
  }
  // Lets make sure that the most recent user/system message is not a retry message
  const getLastSystemOrUserMessage = (
    messages: DBMessage[],
  ): DBMessage | null => {
    for (const message of [...messages].reverse()) {
      if (message.type === "system" || message.type === "user") {
        return message;
      }
    }
    return null;
  };
  let lastSystemOrUserMessage = getLastSystemOrUserMessage(threadChat.messages);
  if (!lastSystemOrUserMessage) {
    console.error("No system or user message found", {
      userId,
      threadId,
      threadChatId,
    });
    return false;
  }
  if (
    lastSystemOrUserMessage.type === "system" &&
    lastSystemOrUserMessage.message_type === "retry-git-commit-and-push"
  ) {
    console.log("Last system or user message is a retry message, ignoring.");
    return false;
  }
  const systemRetryMessage: DBSystemMessage = {
    type: "system",
    message_type: "retry-git-commit-and-push",
    parts: [
      {
        type: "text",
        text: `Failed to commit and push changes with the following error: ${error}. Can you please try again?`,
      },
    ],
  };

  const thread = await getThreadMinimal({ db, userId, threadId });
  if (!thread) {
    return false;
  }
  // Make sure we keep the sandbox active. We're going to kick off a daemon
  // message to retry the commit and push.
  const sandboxId = thread.codesandboxId!;
  await setActiveThreadChat({ sandboxId, threadChatId, isActive: true });
  // Serialize retry enqueue per thread chat to avoid duplicate retry messages.
  await db.transaction(async (tx) => {
    const retryLockKey = `retry-git-commit-and-push:${threadChatId}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${retryLockKey}), 0)`,
    );

    const lockedThreadChat = await tx.query.threadChat.findFirst({
      where: and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.threadChat.threadId, threadId),
      ),
      columns: {
        messages: true,
      },
    });
    const latestSystemOrUserMessage = lockedThreadChat?.messages
      ? getLastSystemOrUserMessage(lockedThreadChat.messages as DBMessage[])
      : null;
    if (
      latestSystemOrUserMessage?.type === "system" &&
      latestSystemOrUserMessage.message_type === "retry-git-commit-and-push"
    ) {
      console.log("Retry message already queued by another worker, skipping.");
      return;
    }

    await sendSystemMessage({
      userId,
      threadId,
      threadChatId,
      message: systemRetryMessage,
    });
  });
  return true;
}
