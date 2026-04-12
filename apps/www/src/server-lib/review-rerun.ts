/**
 * Re-Review Trigger
 *
 * Handles multi-round re-reviews after initial review comments have been posted.
 * When a re-review is triggered (e.g., after the author pushes fixes):
 *
 * 1. Retrieves the review and its previously posted comments
 * 2. Builds a re-review prompt that asks the AI to check each comment's resolution
 * 3. Sends the prompt as a follow-up message in the existing thread
 * 4. When AI completes, the output can be parsed to update per-comment resolution
 *    status and find new issues
 */

import { db } from "@/lib/db";
import { buildReReviewPrompt } from "./review-prompts";
import { updateThreadChat } from "@terragon/shared/model/threads";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import type { DBUserMessage } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreviousReviewComment {
  file: string;
  line: number | null;
  body: string;
  priority: string;
}

export interface TriggerReReviewParams {
  /** ID of the review record */
  reviewId: string;
  /** Full repo name, e.g. "owner/repo" */
  repoFullName: string;
  /** PR number being reviewed */
  prNumber: number;
  /** Base branch the PR targets (e.g. "main") */
  prBaseBranch: string;
  /** User ID of the review owner */
  userId: string;
  /** Thread ID from the initial review */
  threadId: string;
  /** Thread chat ID from the initial review */
  threadChatId: string;
  /** Comments from the previous review round that were posted */
  previousComments: PreviousReviewComment[];
  /**
   * Callback to persist review state changes.
   */
  onPhaseChange: (params: { reviewId: string; phase: string }) => Promise<void>;
}

export interface TriggerReReviewResult {
  threadId: string;
  threadChatId: string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Triggers a re-review on an existing review thread.
 *
 * The re-review prompt includes all previously posted comments and asks the AI
 * to check whether each one was addressed. It also looks for any new issues
 * introduced by the fixes.
 *
 * The message is appended to the existing thread as a queued follow-up message
 * so the sandbox picks it up and runs the re-review in the same environment
 * (with the latest code already pulled).
 */
export async function triggerReReview({
  reviewId,
  repoFullName,
  prNumber,
  prBaseBranch,
  userId,
  threadId,
  threadChatId,
  previousComments,
  onPhaseChange,
}: TriggerReReviewParams): Promise<TriggerReReviewResult> {
  console.log("[review-rerun] triggerReReview", {
    reviewId,
    repoFullName,
    prNumber,
    threadId,
    previousCommentsCount: previousComments.length,
  });

  if (previousComments.length === 0) {
    throw new Error(
      "Cannot trigger re-review without previous comments to check",
    );
  }

  // Update review phase to re_reviewing
  await onPhaseChange({
    reviewId,
    phase: "re_reviewing",
  });

  // Build the re-review prompt
  const reReviewPromptText = buildReReviewPrompt({
    prNumber,
    prBaseBranch,
    repoFullName,
    previousComments,
  });

  // Construct the user message
  const message: DBUserMessage = {
    type: "user",
    model: null, // Use the user's default model
    parts: [
      {
        type: "text",
        text: `Pull the latest changes and re-review.\n\n${reReviewPromptText}`,
      },
    ],
  };

  // Append the re-review message as a queued follow-up in the existing thread.
  // This allows the sandbox to pick it up and process it in sequence.
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendQueuedMessages: [message],
    },
  });

  // Transition the thread chat status to trigger processing
  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId,
    eventType: "user.message",
  });

  if (didUpdateStatus) {
    // Start the agent to process the queued message
    await startAgentMessage({
      db,
      userId,
      threadId,
      threadChatId,
      isNewThread: false,
      createNewBranch: false,
    });
  }

  console.log("[review-rerun] Re-review message queued", {
    reviewId,
    threadId,
    threadChatId,
    didUpdateStatus,
  });

  return { threadId, threadChatId };
}
