/**
 * Review Execution Service
 *
 * Core orchestration logic for triggering AI code reviews in a Terragon sandbox.
 *
 * Flow:
 * 1. Create a thread for the review with the PR's repo checked out on the PR branch
 * 2. Set the thread's initial message to the review prompt
 * 3. Link the review record to the thread
 * 4. The sandbox will execute the review when the thread starts
 *
 * The AI review runs BLIND — no prior bot reviews are fed to the AI.
 * Bot feedback is fetched separately via review-bot-feedback.ts.
 */

import { createNewThread } from "./new-thread-shared";
import { buildReviewPrompt } from "./review-prompts";
import { fetchUnresolvedBotFeedback } from "./review-bot-feedback";
import type { DBUserMessage } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriggerAIReviewParams {
  /** ID of the review record to update */
  reviewId: string;
  /** Full repo name, e.g. "owner/repo" */
  repoFullName: string;
  /** PR number being reviewed */
  prNumber: number;
  /** PR title for prompt context */
  prTitle: string;
  /** Head branch of the PR (the branch with the changes) */
  prHeadBranch: string;
  /** Base branch the PR targets (e.g. "main") */
  prBaseBranch: string;
  /** User ID of the review owner (who triggered the review) */
  userId: string;
  /**
   * Callback to persist review state changes.
   * The execution service is agnostic to the review storage layer — callers
   * provide this callback to update their review record as the review progresses.
   */
  onPhaseChange: (params: {
    reviewId: string;
    phase: string;
    threadId?: string;
    threadChatId?: string;
    botFeedback?: unknown[];
  }) => Promise<void>;
}

export interface TriggerAIReviewResult {
  threadId: string;
  threadChatId: string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Triggers a new AI code review for a PR.
 *
 * Creates a Terragon thread with the review prompt, links it to the review record,
 * and kicks off sandbox execution. The review prompt instructs the AI to perform
 * a blind, independent code review.
 *
 * Bot feedback is fetched in parallel and stored on the review record separately
 * for display in the curation UI.
 */
export async function triggerAIReview({
  reviewId,
  repoFullName,
  prNumber,
  prTitle,
  prHeadBranch,
  prBaseBranch,
  userId,
  onPhaseChange,
}: TriggerAIReviewParams): Promise<TriggerAIReviewResult> {
  console.log("[review-execution] triggerAIReview", {
    reviewId,
    repoFullName,
    prNumber,
    prHeadBranch,
    prBaseBranch,
  });

  // Build the blind review prompt
  const reviewPromptText = buildReviewPrompt({
    prNumber,
    prTitle,
    prBaseBranch,
    repoFullName,
  });

  // Construct the user message for the thread
  const message: DBUserMessage = {
    type: "user",
    model: null, // Use the user's default model
    parts: [{ type: "text", text: reviewPromptText }],
  };

  // Kick off thread creation and bot feedback fetch in parallel
  const [threadResult, botFeedback] = await Promise.all([
    createNewThread({
      userId,
      message,
      githubRepoFullName: repoFullName,
      // The PR head branch is an existing branch — don't create a new one
      headBranchName: prHeadBranch,
      baseBranchName: prBaseBranch,
      githubPRNumber: prNumber,
      generateName: true,
      sourceType: "automation",
      disableGitCheckpointing: true, // Reviews don't need checkpointing
      runInDeliveryLoop: false,
    }),
    fetchUnresolvedBotFeedback({ repoFullName, prNumber }).catch((error) => {
      console.error(
        "[review-execution] Failed to fetch bot feedback, continuing without it",
        { reviewId, error },
      );
      return [] as Awaited<ReturnType<typeof fetchUnresolvedBotFeedback>>;
    }),
  ]);

  const { threadId, threadChatId } = threadResult;

  // Update the review record: link thread, set phase, store bot feedback
  await onPhaseChange({
    reviewId,
    phase: "ai_reviewing",
    threadId,
    threadChatId,
    botFeedback,
  });

  console.log("[review-execution] Review thread created", {
    reviewId,
    threadId,
    threadChatId,
    botFeedbackCount: botFeedback.length,
  });

  return { threadId, threadChatId };
}
