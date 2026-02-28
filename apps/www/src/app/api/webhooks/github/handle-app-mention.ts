import { newThreadInternal } from "@/server-lib/new-thread-internal";
import {
  getOctokitForUser,
  parseRepoFullName,
  getOctokitForApp,
  getIssueAuthorGitHubUsername,
  getPRAuthorGitHubUsername,
  getIsIssueAuthor,
  getIsPRAuthor,
} from "@/lib/github";
import {
  getUserIdByGitHubAccountId,
  getUserSettings,
} from "@terragon/shared/model/user";
import { db } from "@/lib/db";
import { getThreadForGithubPRAndUser } from "@terragon/shared/model/github";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getGitHubMentionAutomationsForRepo } from "@terragon/shared/model/automations";
import { GitHubMentionTriggerConfig } from "@terragon/shared/automations";
import { Automation } from "@terragon/shared/db/types";
import { DBUserMessage } from "@terragon/shared/db/db-message";
import type { ThreadSource, ThreadSourceMetadata } from "@terragon/shared";
import {
  addEyesReactionToComment,
  isKnownGitHubAccount,
  postIntegrationSetupComment,
  extractModelFromComment,
} from "./utils";
import { maybeBatchThreads } from "@/lib/batch-threads";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { getThread, getThreadChat } from "@terragon/shared/model/threads";
import { modelToAgent } from "@terragon/agent/utils";
import {
  ensureSdlcLoopEnrollmentForGithubPRIfEnabled,
  getActiveSdlcLoopForGithubPRIfEnabled,
  isSdlcLoopEnrollmentAllowedForThread,
} from "@/server-lib/sdlc-loop/enrollment";

// Handle app mention by adding to existing thread or creating a new one
export async function handleAppMention({
  repoFullName,
  issueOrPrNumber,
  issueOrPrType,
  commentId,
  commentBody,
  commentGitHubUsername,
  commentGitHubAccountId,
  commentType,
  diffContext,
  commentContext,
  issueContext,
}: {
  repoFullName: string;
  issueOrPrNumber: number;
  issueOrPrType: "pull_request" | "issue";
  commentId: number;
  commentBody: string;
  commentGitHubUsername: string;
  commentGitHubAccountId?: number;
  commentType?: "issue_comment" | "review_comment";
  diffContext?: string;
  commentContext?: string;
  issueContext?: string;
}): Promise<void> {
  // Get branch names upfront
  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });
  let branchName: string;
  let baseBranchName: string;

  try {
    if (issueOrPrType === "pull_request") {
      const pr = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: issueOrPrNumber,
      });
      branchName = pr.data.head.ref;
      baseBranchName = pr.data.base.ref;
    } else {
      const repoInfo = await octokit.rest.repos.get({
        owner,
        repo,
      });
      branchName = repoInfo.data.default_branch;
      baseBranchName = repoInfo.data.default_branch;
    }
  } catch (error) {
    console.error(
      `Error fetching branch name for ${issueOrPrType} #${issueOrPrNumber}:`,
      error,
    );
    return;
  }
  const knownAccount = await isKnownGitHubAccount({
    gitHubAccountId: commentGitHubAccountId,
  });
  if (!knownAccount) {
    console.log(
      `GitHub user ${commentGitHubUsername} has no access, posting setup guidance comment`,
    );
    await postIntegrationSetupComment({
      octokit,
      owner,
      repo,
      issueNumber: issueOrPrNumber,
      reviewCommentId: commentId,
    });
    return;
  }

  // Find all Terragon users who should get tasks created
  const usersToTriggerTasks = await getUsersToTriggerTasks({
    repoFullName,
    issueOrPrType,
    issueOrPrNumber,
    commentGitHubUsername,
    commentGitHubAccountId,
  });
  if (usersToTriggerTasks.length === 0) {
    console.log(`No users to create tasks for mention`, {
      issueOrPrType,
      issueOrPrNumber,
      repoFullName,
    });
    return;
  }
  console.log(
    `Found ${usersToTriggerTasks.length} users to trigger tasks for mention on ${issueOrPrType} #${issueOrPrNumber} in ${repoFullName}`,
  );
  if (commentType) {
    await addEyesReactionToComment({
      octokit,
      owner,
      repo,
      commentId,
      commentType,
    });
  }
  // Trigger one task per user
  await Promise.allSettled(
    usersToTriggerTasks.map(({ userId, automation }) =>
      triggerTasksForUser({
        userId,
        automation,
        repoFullName,
        issueOrPrNumber,
        issueOrPrType,
        commentId,
        commentBody,
        commentGitHubUsername,
        branchName,
        baseBranchName,
        diffContext,
        commentContext,
        issueContext,
      }),
    ),
  );
}

function getUserMessageText({
  isIssueOrPrAuthor,
  commentGitHubUsername,
  issueOrPrType,
  issueOrPrNumber,
  commentBody,
  isFollowUp,
  diffContext,
  commentContext,
  issueContext,
}: {
  isIssueOrPrAuthor: boolean;
  commentGitHubUsername: string;
  issueOrPrType: "pull_request" | "issue";
  issueOrPrNumber: number;
  commentBody: string;
  isFollowUp: boolean;
  diffContext?: string;
  commentContext?: string;
  issueContext?: string;
}): string {
  const messageParts: string[] = [];
  const issueOrPrStr = issueOrPrType === "pull_request" ? "PR" : "Issue";
  if (isFollowUp) {
    if (isIssueOrPrAuthor) {
      messageParts.push(
        `I left a comment on ${issueOrPrStr} #${issueOrPrNumber}:`,
      );
    } else {
      messageParts.push(
        `@${commentGitHubUsername} mentioned you on ${issueOrPrStr} #${issueOrPrNumber}:`,
      );
    }
  } else {
    messageParts.push(
      `@${commentGitHubUsername} mentioned you on ${issueOrPrStr} #${issueOrPrNumber}:`,
    );
  }

  // Add issue context if available
  if (issueOrPrType === "issue" && issueContext) {
    messageParts.push("Issue context:", issueContext);
  }
  // Add diff context if available
  if (diffContext) {
    messageParts.push("Comment context:", diffContext);
  }
  // Add comment thread context if available (for PR issue comments)
  if (commentContext) {
    messageParts.push(commentContext);
  }
  if (isFollowUp && isIssueOrPrAuthor) {
    messageParts.push("My comment:", commentBody);
  } else {
    messageParts.push("This is the message:", commentBody);
  }
  messageParts.push(
    "You can use the github cli to pull comments, reply, and push changes.",
  );
  return messageParts.join("\n\n");
}

type UserIdAndAutomation = {
  userId: string;
  automation: Automation | null;
};

async function getUsersToTriggerTasks({
  repoFullName,
  issueOrPrType,
  issueOrPrNumber,
  commentGitHubUsername,
  commentGitHubAccountId,
}: {
  repoFullName: string;
  issueOrPrType: "pull_request" | "issue";
  issueOrPrNumber: number;
  commentGitHubUsername: string;
  commentGitHubAccountId: number | undefined;
}): Promise<UserIdAndAutomation[]> {
  const [automations, mentioningUserId] = await Promise.all([
    getGitHubMentionAutomationsForRepo({
      db,
      repoFullName,
    }),
    getUserIdByGitHubAccountId({
      db,
      accountId: commentGitHubAccountId?.toString() || "",
    }),
  ]);
  const isMatchingGitHubMentionAutomationArr = await Promise.all(
    automations.map(async (automation) => {
      return isMatchingGitHubMentionAutomation({
        automation,
        repoFullName,
        issueOrPrType,
        issueOrPrNumber,
        commentGitHubUsername,
        mentioningUserId,
      });
    }),
  );

  const matchingAutomationsByUserId: Record<string, Automation> = {};
  for (let i = 0; i < automations.length; i++) {
    const automation = automations[i]!;
    const isMatching = isMatchingGitHubMentionAutomationArr[i];
    if (isMatching) {
      matchingAutomationsByUserId[automation.userId] = automation;
    }
  }

  const usersToTriggerTasks: UserIdAndAutomation[] = [];
  if (mentioningUserId && !matchingAutomationsByUserId[mentioningUserId]) {
    usersToTriggerTasks.push({ userId: mentioningUserId, automation: null });
  }
  for (const [userId, automation] of Object.entries(
    matchingAutomationsByUserId,
  )) {
    usersToTriggerTasks.push({ userId, automation });
  }
  return usersToTriggerTasks;
}

async function triggerTasksForUser({
  userId,
  automation,
  repoFullName,
  issueOrPrNumber,
  issueOrPrType,
  commentId,
  commentBody,
  commentGitHubUsername,
  branchName,
  baseBranchName,
  diffContext,
  commentContext,
  issueContext,
}: {
  userId: string;
  automation: Automation | null;
  repoFullName: string;
  issueOrPrNumber: number;
  issueOrPrType: "pull_request" | "issue";
  commentId: number | undefined;
  commentBody: string;
  commentGitHubUsername: string;
  branchName: string;
  baseBranchName: string;
  diffContext?: string;
  commentContext?: string;
  issueContext?: string;
}): Promise<void> {
  try {
    const octokit = await getOctokitForUser({ userId });
    if (!octokit) {
      console.error(`No github access token found for user ${userId}`);
      return;
    }
    const [isIssueOrPrAuthor, userSettings, batchingEnabled] =
      await Promise.all([
        getIsIssueOrPrAuthor({
          userId,
          repoFullName,
          issueOrPrNumber,
          issueOrPrType,
        }),
        getUserSettings({ db, userId }),
        getFeatureFlagForUser({ db, userId, flagName: "batchGitHubMentions" }),
      ]);

    const additionalUserMessage = automation?.action?.config?.message;

    const getUserMessageToSend = ({
      forcedAgent,
      isFollowUp,
    }: {
      forcedAgent: AIAgent | null;
      isFollowUp: boolean;
    }): DBUserMessage => {
      // Model priority:
      // 1. Model extracted from comment (if feature flag enabled)
      // 2. Model from automation config
      // 3. User's default GitHub mention model
      // 4. null (system default)
      const modelCandidates: (AIModel | null | undefined)[] = [
        extractModelFromComment({ commentBody }),
        additionalUserMessage?.model,
        userSettings.defaultGitHubMentionModel,
      ].filter((model) => {
        if (model && forcedAgent) {
          return modelToAgent(model) === forcedAgent;
        }
        return true;
      });
      return {
        type: "user",
        model: modelCandidates.find((model) => !!model) ?? null,
        parts: [
          {
            type: "text",
            text: getUserMessageText({
              isIssueOrPrAuthor,
              commentGitHubUsername,
              issueOrPrType,
              issueOrPrNumber,
              commentBody,
              isFollowUp,
              diffContext,
              commentContext,
              issueContext,
            }),
          },
          ...(additionalUserMessage?.parts.length
            ? [
                { type: "text" as const, text: "\n\n" },
                ...additionalUserMessage.parts,
              ]
            : []),
        ],
        timestamp: new Date().toISOString(),
      };
    };

    const queueOrCreateThreadForGitHubMention = async ({
      threadIdOrNull,
      threadChatIdOrNull,
      forcedAgent,
      threadSourceType,
      threadSourceMetadata,
    }: {
      threadIdOrNull: string | null;
      threadChatIdOrNull: string | null;
      forcedAgent: AIAgent | null;
      threadSourceType?: ThreadSource | null;
      threadSourceMetadata?: ThreadSourceMetadata | null;
    }): Promise<{ threadId: string; threadChatId: string }> => {
      const maybeEnsureSdlcEnrollment = async ({
        threadId,
        sourceType,
        sourceMetadata,
      }: {
        threadId: string;
        sourceType: ThreadSource | null;
        sourceMetadata: ThreadSourceMetadata | null;
      }) => {
        if (issueOrPrType !== "pull_request") {
          return;
        }
        if (
          !isSdlcLoopEnrollmentAllowedForThread({ sourceType, sourceMetadata })
        ) {
          return;
        }
        try {
          await ensureSdlcLoopEnrollmentForGithubPRIfEnabled({
            userId,
            repoFullName,
            prNumber: issueOrPrNumber,
            threadId,
          });
        } catch (error) {
          console.warn(
            "SDLC enrollment wiring failed for PR mention routing; continuing with standard thread flow",
            {
              userId,
              repoFullName,
              issueOrPrNumber,
              threadId,
              error,
            },
          );
        }
      };

      if (threadIdOrNull && threadChatIdOrNull) {
        console.log(`Queuing follow-up to existing thread`, {
          threadId: threadIdOrNull,
          threadChatId: threadChatIdOrNull,
          issueOrPrType,
          issueOrPrNumber,
          repoFullName,
          userId,
        });
        await queueFollowUpInternal({
          userId,
          threadId: threadIdOrNull,
          threadChatId: threadChatIdOrNull,
          messages: [getUserMessageToSend({ forcedAgent, isFollowUp: true })],
          source: "github",
          appendOrReplace: "append",
        });
        let sourceType = threadSourceType ?? null;
        let sourceMetadata = threadSourceMetadata ?? null;
        if (!sourceType && !sourceMetadata) {
          const existingThread = await getThread({
            db,
            userId,
            threadId: threadIdOrNull,
          });
          sourceType = existingThread?.sourceType ?? null;
          sourceMetadata = existingThread?.sourceMetadata ?? null;
        }
        await maybeEnsureSdlcEnrollment({
          threadId: threadIdOrNull,
          sourceType,
          sourceMetadata,
        });
        return { threadId: threadIdOrNull, threadChatId: threadChatIdOrNull };
      }
      console.log(`Creating new thread`, {
        issueOrPrType,
        issueOrPrNumber,
        repoFullName,
        userId,
      });
      const mentionSourceMetadata: ThreadSourceMetadata = {
        type: "github-mention",
        repoFullName,
        issueOrPrNumber,
        commentId,
      };
      const { threadId, threadChatId } = await newThreadInternal({
        userId,
        message: getUserMessageToSend({ forcedAgent: null, isFollowUp: false }),
        parentThreadId: undefined,
        parentToolId: undefined,
        automation: automation ?? undefined,
        githubRepoFullName: repoFullName,
        baseBranchName,
        headBranchName:
          issueOrPrType === "pull_request" ? branchName : undefined,
        githubPRNumber:
          issueOrPrType === "pull_request" ? issueOrPrNumber : undefined,
        githubIssueNumber:
          issueOrPrType === "issue" ? issueOrPrNumber : undefined,
        sourceType: "github-mention",
        sourceMetadata: mentionSourceMetadata,
      });
      console.log(`Created new thread`, {
        threadId,
        threadChatId,
        issueOrPrType,
        issueOrPrNumber,
        repoFullName,
        userId,
      });
      await maybeEnsureSdlcEnrollment({
        threadId,
        sourceType: "github-mention",
        sourceMetadata: mentionSourceMetadata,
      });
      return { threadId, threadChatId };
    };

    if (issueOrPrType === "pull_request") {
      const activeSdlcLoop = await getActiveSdlcLoopForGithubPRIfEnabled({
        userId,
        repoFullName,
        prNumber: issueOrPrNumber,
      });

      if (activeSdlcLoop) {
        const enrolledThread = await getThread({
          db,
          userId,
          threadId: activeSdlcLoop.threadId,
        });
        let enrolledThreadChat: ReturnType<typeof getPrimaryThreadChat> | null =
          null;
        if (enrolledThread) {
          try {
            enrolledThreadChat = getPrimaryThreadChat(enrolledThread);
          } catch (_error) {
            enrolledThreadChat = null;
          }
        }

        if (enrolledThreadChat) {
          await queueOrCreateThreadForGitHubMention({
            threadIdOrNull: activeSdlcLoop.threadId,
            threadChatIdOrNull: enrolledThreadChat.id,
            forcedAgent: enrolledThreadChat.agent,
            threadSourceType: enrolledThread?.sourceType ?? null,
            threadSourceMetadata: enrolledThread?.sourceMetadata ?? null,
          });
          return;
        }

        console.warn(
          "SDLC loop enrollment found but thread/chat is not routable; falling back to standard mention routing",
          {
            userId,
            repoFullName,
            issueOrPrNumber,
            sdlcLoopId: activeSdlcLoop.id,
            sdlcLoopThreadId: activeSdlcLoop.threadId,
            hasThread: !!enrolledThread,
          },
        );
      }
    }

    if (userSettings.singleThreadForGitHubMentions) {
      const threadOrNull = await getThreadForGithubPRAndUser({
        db,
        repoFullName,
        prNumber: issueOrPrNumber,
        userId,
      });
      if (threadOrNull) {
        const threadChat = getPrimaryThreadChat(threadOrNull);
        await queueOrCreateThreadForGitHubMention({
          threadIdOrNull: threadOrNull.id,
          threadChatIdOrNull: threadChat.id,
          forcedAgent: threadChat.agent,
          threadSourceType: threadOrNull.sourceType,
          threadSourceMetadata: threadOrNull.sourceMetadata,
        });
        return;
      }
    }
    if (!batchingEnabled) {
      await queueOrCreateThreadForGitHubMention({
        threadIdOrNull: null,
        threadChatIdOrNull: null,
        forcedAgent: null,
      });
      return;
    }
    // Use batching to prevent multiple concurrent mentions from creating multiple threads/sandboxes
    const batchKey = `github-mention:${repoFullName}:${issueOrPrNumber}`;
    const { threadId, threadChatId, didCreateNewThread } =
      await maybeBatchThreads({
        userId,
        batchKey,
        expiresSecs: 60, // 1 minute window for batching
        maxWaitTimeMs: 5000,
        createNewThread: async () => {
          return await queueOrCreateThreadForGitHubMention({
            threadIdOrNull: null,
            threadChatIdOrNull: null,
            forcedAgent: null,
          });
        },
      });
    if (!didCreateNewThread) {
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId,
      });
      const threadOrNull = await getThread({
        db,
        userId,
        threadId,
      });
      await queueOrCreateThreadForGitHubMention({
        threadIdOrNull: threadId,
        threadChatIdOrNull: threadChatId,
        forcedAgent: threadChat?.agent ?? null,
        threadSourceType: threadOrNull?.sourceType ?? null,
        threadSourceMetadata: threadOrNull?.sourceMetadata ?? null,
      });
    }
  } catch (error) {
    console.error(`Failed to create task for user ${userId}:`, error);
  }
}

async function isMatchingGitHubMentionAutomation({
  automation,
  repoFullName,
  issueOrPrType,
  issueOrPrNumber,
  commentGitHubUsername,
  mentioningUserId,
}: {
  automation: Automation;
  repoFullName: string;
  issueOrPrType: "pull_request" | "issue";
  issueOrPrNumber: number;
  commentGitHubUsername: string;
  mentioningUserId: string | undefined;
}): Promise<boolean> {
  if (automation.triggerType !== "github_mention") {
    return false;
  }
  if (mentioningUserId === automation.userId) {
    return true;
  }
  const config = automation.triggerConfig as GitHubMentionTriggerConfig;
  // Check bot mention filter conditions
  let botMentionMatches = false;
  if (
    commentGitHubUsername.endsWith("[bot]") &&
    config.filter.includeBotMentions &&
    config.filter.botUsernames
  ) {
    const allowedBots = config.filter.botUsernames
      .split(",")
      .map((bot) => bot.trim().toLowerCase());
    if (allowedBots.includes(commentGitHubUsername.toLowerCase())) {
      botMentionMatches = true;
    }
  }
  if (!botMentionMatches) {
    return false;
  }
  try {
    const isAuthor = await getIsIssueOrPrAuthor({
      userId: automation.userId,
      repoFullName,
      issueOrPrNumber,
      issueOrPrType,
    });
    if (isAuthor) {
      return true;
    }
    if (config.filter.includeOtherAuthors && config.filter.otherAuthors) {
      const authorGitHubUsername =
        issueOrPrType === "pull_request"
          ? await getPRAuthorGitHubUsername({
              repoFullName,
              prNumber: issueOrPrNumber,
            })
          : await getIssueAuthorGitHubUsername({
              repoFullName,
              issueNumber: issueOrPrNumber,
            });
      const allowedAuthors = config.filter.otherAuthors
        .split(",")
        .map((author) => author.trim().toLowerCase());
      if (allowedAuthors.includes(authorGitHubUsername.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error(
      `Error checking author for ${issueOrPrType} #${issueOrPrNumber} in ${repoFullName}:`,
      error,
    );
  }
  return false;
}

async function getIsIssueOrPrAuthor({
  userId,
  repoFullName,
  issueOrPrNumber,
  issueOrPrType,
}: {
  userId: string;
  repoFullName: string;
  issueOrPrNumber: number;
  issueOrPrType: "pull_request" | "issue";
}): Promise<boolean> {
  return issueOrPrType === "pull_request"
    ? await getIsPRAuthor({ userId, repoFullName, prNumber: issueOrPrNumber })
    : await getIsIssueAuthor({
        userId,
        repoFullName,
        issueNumber: issueOrPrNumber,
      });
}
