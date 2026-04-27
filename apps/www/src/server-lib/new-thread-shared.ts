import { modelToAgent } from "@terragon/agent/utils";
import {
  Automation,
  DBUserMessage,
  ThreadSource,
  ThreadSourceMetadata,
} from "@terragon/shared";
import { getOrCreateEnvironment } from "@terragon/shared/model/environments";
import {
  createThread,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { getUserSettings } from "@terragon/shared/model/user";
import { waitUntil } from "@vercel/functions";
import { dispatchAgentMessage } from "@/agent/msg/startAgentMessage";
import { getSandboxProvider } from "@/agent/sandbox";
import { userMessageToPlainText } from "@/components/promptbox/tiptap-to-richtext";
import { db } from "@/lib/db";
import {
  convertToPlainText,
  estimateMessageSize,
  imageCount,
} from "@/lib/db-message-helpers";
import {
  ensureBranchExists,
  findAndAssociatePR,
  getDefaultBranchForRepo,
  updateGitHubPR,
} from "@/lib/github";
import { sendLoopsEvent, updateLoopsContact } from "@/lib/loops";
import { getPostHogServer } from "@/lib/posthog-server";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";
import { checkShadowBanTaskCreationRateLimit } from "@/lib/rate-limit";
import { UserFacingError } from "@/lib/server-actions";
import { getSandboxSizeForUser } from "@/lib/subscription-tiers";
import { generateThreadName } from "@/server-lib/generate-thread-name";
import { getThreadChatHistory } from "./compact";
import { getDefaultModel } from "./default-ai-model";

export interface CreateThreadOptions {
  userId: string;
  message: DBUserMessage;
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  parentThreadId?: string;
  parentToolId?: string;
  automation?: Automation;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  generateName?: boolean;
  saveAsDraft?: boolean;
  scheduleAt?: number | null;
  disableGitCheckpointing?: boolean;
  skipSetup?: boolean;
  sourceType: ThreadSource;
  sourceMetadata?: ThreadSourceMetadata;
  delayMs?: number;
}

/**
 * Shared logic for creating a new thread.
 * This function is used by both new-thread.ts and new-thread-internal.ts
 */
export async function createNewThread({
  userId,
  message,
  githubRepoFullName,
  baseBranchName,
  headBranchName,
  parentThreadId,
  parentToolId,
  automation,
  githubPRNumber,
  githubIssueNumber,
  generateName = true,
  saveAsDraft = false,
  scheduleAt = null,
  disableGitCheckpointing = false,
  skipSetup = false,
  sourceType,
  sourceMetadata,
  delayMs = 0,
}: CreateThreadOptions): Promise<{
  threadId: string;
  threadChatId: string;
  model: NonNullable<DBUserMessage["model"]>;
}> {
  // Enforce per-user shadow-ban rate limit if applicable
  await checkShadowBanTaskCreationRateLimit(userId);
  if (!baseBranchName) {
    baseBranchName = await getDefaultBranchForRepo({
      userId,
      repoFullName: githubRepoFullName,
    });
  }
  const [
    modelOrDefault,
    userSettings,
    sandboxSize,
    _enableEnvironmentCreation,
    _ensureBaseBranchExists,
    _ensureHeadBranchExists,
  ] = await Promise.all([
    (async () => {
      return message.model ?? (await getDefaultModel({ userId }));
    })(),
    // Get user settings for sandbox provider
    getUserSettings({ db, userId }),
    // Get sandbox size for user
    getSandboxSizeForUser(userId),
    // Ensure the environment exists for this repo
    getOrCreateEnvironment({ db, userId, repoFullName: githubRepoFullName }),
    // Make sure that the repo base branch exists in the repo
    ensureBranchExists({
      userId,
      repoFullName: githubRepoFullName,
      branchName: baseBranchName,
    }),
    // Make sure that the branch exists in the repo if a branch name is provided
    (async () => {
      if (headBranchName) {
        await ensureBranchExists({
          userId,
          repoFullName: githubRepoFullName,
          branchName: headBranchName,
        });
      }
    })(),
  ]);
  const messageWithModel = { ...message, model: modelOrDefault };
  const agent = modelToAgent(messageWithModel.model);
  // Track thread creation
  getPostHogServer().capture({
    distinctId: userId,
    event: "new_thread",
    properties: {
      source: sourceType,
      repoFullName: githubRepoFullName,
      baseBranchName,
      headBranchName,
      model: messageWithModel.model,
      agentType: agent,
      promptTextSize: estimateMessageSize(messageWithModel),
      imageCount: imageCount(messageWithModel),
      saveAsDraft,
    },
  });

  // Send task_created event to Loops for engagement tracking
  // This enables churn/re-engagement campaigns based on user activity
  waitUntil(
    Promise.all([
      sendLoopsEvent(userId, "task_created", {
        source: sourceType,
        repoFullName: githubRepoFullName,
        model: messageWithModel.model,
        isDraft: saveAsDraft,
        isScheduled: !!scheduleAt,
      }),
      // Update contact's lastTaskCreatedAt for segment-based campaigns
      updateLoopsContact(userId, {
        lastTaskCreatedAtDate: new Date().toISOString(),
      }),
    ]),
  );

  const sandboxProvider = await getSandboxProvider({
    userSetting: userSettings?.sandboxProvider,
    userId,
  });

  // Generate an initial thread name
  const automationThreadName = automation
    ? getThreadNameForAutomation({
        automation,
        githubPRNumber,
        githubIssueNumber,
      })
    : null;
  const initialThreadName =
    automationThreadName ?? userMessageToPlainText(message);
  const shouldGenerateName = generateName && !automationThreadName;

  // Create the thread
  const { threadId, threadChatId } = await createThread({
    db,
    userId,
    threadValues: {
      githubRepoFullName,
      repoBaseBranchName: baseBranchName,
      branchName: headBranchName,
      name: initialThreadName,
      sandboxProvider,
      sandboxSize,
      parentThreadId,
      parentToolId,
      automationId: automation?.id,
      githubPRNumber,
      githubIssueNumber,
      disableGitCheckpointing,
      skipSetup,
      sourceType,
      sourceMetadata,
    },
    initialChatValues: {
      agent,
      permissionMode: message.permissionMode || "allowAll",
      status: scheduleAt ? "scheduled" : saveAsDraft ? "draft" : "queued",
    },
  });

  // If saving as draft, update the thread with the user message
  if (saveAsDraft) {
    await updateThread({
      db,
      userId,
      threadId,
      updates: {
        draftMessage: await uploadUserMessageImages({ userId, message }),
      },
    });
    return { threadId, threadChatId, model: messageWithModel.model };
  }

  const updateThreadMetadata = () => {
    if (shouldGenerateName) {
      waitUntil(
        generateAndUpdateThreadName({
          userId,
          threadId,
          message: messageWithModel,
        }),
      );
    }
    if (githubPRNumber) {
      waitUntil(
        (async () => {
          await updateGitHubPR({
            repoFullName: githubRepoFullName,
            prNumber: githubPRNumber,
            createIfNotFound: true,
          });
        })(),
      );
    } else if (headBranchName) {
      waitUntil(
        (async () => {
          await findAndAssociatePR({
            userId,
            threadId,
            repoFullName: githubRepoFullName,
            headBranchName,
            baseBranchName,
          });
        })(),
      );
    }
  };

  if (scheduleAt) {
    if (scheduleAt < Date.now()) {
      throw new UserFacingError("Schedule time must be in the future");
    }
    await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
      updates: {
        scheduleAt: new Date(scheduleAt),
        appendMessages: [
          await uploadUserMessageImages({
            userId,
            message: messageWithModel,
          }),
        ],
      },
    });
    updateThreadMetadata();
    return { threadId, threadChatId, model: messageWithModel.model };
  }

  // Determine if "Disable git checkpointing" should force no new branch on create
  let effectiveCreateNewBranch = !headBranchName;
  if (disableGitCheckpointing) {
    effectiveCreateNewBranch = false;
  }

  // If the thread is being forked, add the thread context message to the new thread
  if (sourceMetadata?.type === "www-fork") {
    await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "thread-context",
            threadId: sourceMetadata.parentThreadId,
            threadChatId: sourceMetadata.parentThreadChatId,
            threadChatHistory: await getThreadChatHistory({
              userId,
              threadId: sourceMetadata.parentThreadId,
              threadChatId: sourceMetadata.parentThreadChatId,
            }),
            taskDescription: convertToPlainText({ message: messageWithModel }),
          },
        ],
      },
    });
  }

  // Start processing the message
  waitUntil(
    dispatchAgentMessage({
      db,
      userId,
      message: messageWithModel,
      threadId,
      threadChatId,
      isNewThread: true,
      createNewBranch: effectiveCreateNewBranch,
      branchName: effectiveCreateNewBranch
        ? undefined
        : headBranchName || baseBranchName,
      delayMs,
    }).catch((error) => {
      console.error("Error in dispatchAgentMessage:", error);
    }),
  );
  updateThreadMetadata();
  return {
    threadId,
    threadChatId,
    model: messageWithModel.model,
  };
}

export async function generateAndUpdateThreadName({
  userId,
  threadId,
  message,
}: {
  userId: string;
  threadId: string;
  message: DBUserMessage;
}) {
  const generatedName = await generateThreadName(message);
  if (generatedName) {
    await updateThread({
      db,
      userId,
      threadId,
      updates: {
        name: generatedName,
      },
    });
  }
}

function getThreadNameForAutomation({
  automation,
  githubPRNumber,
  githubIssueNumber,
}: {
  automation: Automation;
  githubPRNumber?: number;
  githubIssueNumber?: number;
}): string | null {
  const automationName = automation.name;
  switch (automation.triggerType) {
    case "github_mention":
      return null;
    case "pull_request":
      return `${automationName} / #${githubPRNumber!}`;
    case "issue":
      return `${automationName} / #${githubIssueNumber!}`;
    case "schedule":
      return automationName;
    case "manual":
      return automationName;
    default:
      const _exhaustiveCheck: never = automation.triggerType;
      console.error("Unexpected trigger type:", _exhaustiveCheck);
      return null;
  }
}
