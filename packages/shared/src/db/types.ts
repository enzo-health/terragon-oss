import { SelectedAIModels } from "@terragon/agent/types";
import { AutomationTrigger, AutomationTriggerType } from "../automations";
import * as schema from "../db/schema";

type UserInner = typeof schema.user.$inferSelect;
type SessionInner = typeof schema.session.$inferSelect;

// In better-auth, some of the fields becoming optional, so we need to make them optional here
// to make typescript happy.
type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type User = WithOptional<
  UserInner,
  | "image"
  | "role"
  | "banned"
  | "banReason"
  | "banExpires"
  | "shadowBanned"
  | "stripeCustomerId"
>;
export type Session = WithOptional<
  SessionInner,
  "ipAddress" | "userAgent" | "impersonatedBy"
>;
export type UserStripePromotionCode =
  typeof schema.userStripePromotionCode.$inferSelect;
export type UserStripePromotionCodeInsert =
  typeof schema.userStripePromotionCode.$inferInsert;

export type ThreadVisibility = "private" | "link" | "repo";

export type ClaudeOrganizationType =
  | "claude_pro"
  | "claude_max"
  | "claude_enterprise"
  | "claude_team";

export type SandboxStatus =
  | "unknown"
  | "provisioning"
  | "booting"
  | "running"
  | "paused"
  | "killed";

export type Thread = typeof schema.thread.$inferSelect;
export type ThreadChat = typeof schema.threadChat.$inferSelect;
export type UserSettings = typeof schema.userSettings.$inferSelect;
export type Environment = typeof schema.environment.$inferSelect;
export type Waitlist = typeof schema.waitlist.$inferSelect;
export type SdlcLoop = typeof schema.sdlcLoop.$inferSelect;
export type SdlcLoopInsert = typeof schema.sdlcLoop.$inferInsert;
export type SdlcLoopLease = typeof schema.sdlcLoopLease.$inferSelect;
export type SdlcLoopLeaseInsert = typeof schema.sdlcLoopLease.$inferInsert;
export type SdlcLoopSignalInbox =
  typeof schema.sdlcLoopSignalInbox.$inferSelect;
export type SdlcLoopSignalInboxInsert =
  typeof schema.sdlcLoopSignalInbox.$inferInsert;
export type SdlcLoopOutbox = typeof schema.sdlcLoopOutbox.$inferSelect;
export type SdlcLoopOutboxInsert = typeof schema.sdlcLoopOutbox.$inferInsert;
export type SdlcLoopOutboxAttempt =
  typeof schema.sdlcLoopOutboxAttempt.$inferSelect;
export type SdlcLoopOutboxAttemptInsert =
  typeof schema.sdlcLoopOutboxAttempt.$inferInsert;
export type GithubWebhookDelivery =
  typeof schema.githubWebhookDeliveries.$inferSelect;
export type GithubWebhookDeliveryInsert =
  typeof schema.githubWebhookDeliveries.$inferInsert;
export type AgentProviderCredentials =
  typeof schema.agentProviderCredentials.$inferSelect;
export type AgentProviderCredentialsInsert =
  typeof schema.agentProviderCredentials.$inferInsert;
export type SlackInstallation = typeof schema.slackInstallation.$inferSelect;
export type SlackInstallationInsert =
  typeof schema.slackInstallation.$inferInsert;
export type SlackAccount = typeof schema.slackAccount.$inferSelect;
export type SlackAccountInsert = typeof schema.slackAccount.$inferInsert;
export type SlackSettings = typeof schema.slackSettings.$inferSelect;
export type SlackSettingsInsert = typeof schema.slackSettings.$inferInsert;
export type LinearAccount = typeof schema.linearAccount.$inferSelect;
export type LinearAccountInsert = typeof schema.linearAccount.$inferInsert;
export type LinearSettings = typeof schema.linearSettings.$inferSelect;
export type LinearSettingsInsert = typeof schema.linearSettings.$inferInsert;
export type LinearInstallation = typeof schema.linearInstallation.$inferSelect;
export type LinearInstallationInsert =
  typeof schema.linearInstallation.$inferInsert;

// Token-free projection safe to serialize across the RSC → client boundary.
// Never pass the full LinearInstallation to client components — it contains
// encrypted token ciphertext and internal user identifiers that should remain
// server-side only.
export type LinearInstallationPublic = Omit<
  LinearInstallation,
  "accessTokenEncrypted" | "refreshTokenEncrypted" | "scope" | "installerUserId"
>;
export type ThreadReadStatus = typeof schema.threadReadStatus.$inferSelect;
export type ThreadReadStatusInsert =
  typeof schema.threadReadStatus.$inferInsert;
export type UserFlags = typeof schema.userFlags.$inferSelect;
export type UserFlagsInsert = typeof schema.userFlags.$inferInsert;
export type UserInfoServerSide = typeof schema.userInfoServerSide.$inferSelect;
export type UserInfoServerSideInsert =
  typeof schema.userInfoServerSide.$inferInsert;
export type Feedback = typeof schema.feedback.$inferSelect;
export type FeedbackInsert = typeof schema.feedback.$inferInsert;
export type FeedbackType = "bug" | "feature" | "feedback";

export type SlackAccountWithMetadata = SlackAccount & {
  installation: SlackInstallation | null;
  settings: SlackSettings | null;
};

export type LinearAccountWithSettings = LinearAccount & {
  settings: LinearSettings | null;
};

export type LinearAccountWithSettingsAndInstallation =
  LinearAccountWithSettings & {
    installation: LinearInstallationPublic | null;
  };

export type ThreadSource =
  | "www"
  | "www-redo"
  | "www-fork"
  | "www-multi-agent"
  | "www-suggested-followup-task"
  | "webhook" // Deprecated
  | "automation"
  | "slack-mention"
  | "github-mention"
  | "linear-mention"
  | "cli";

export type ThreadSourceMetadata =
  | {
      type: "www";
      sdlcLoopOptIn: boolean;
    }
  | {
      type: "github-mention";
      repoFullName: string;
      issueOrPrNumber: number;
      commentId?: number;
    }
  | {
      type: "slack-mention";
      workspaceDomain: string;
      channel: string;
      messageTs: string;
      threadTs?: string;
    }
  | {
      type: "www-fork";
      parentThreadId: string;
      parentThreadChatId: string;
    }
  | {
      type: "linear-mention";
      /**
       * Linear agent session ID — required on new records (fn-2+).
       * Legacy fn-1 threads may not have this field. Guards:
       *   if (!thread.sourceMetadata?.agentSessionId) { log("legacy thread, skipping"); return; }
       */
      agentSessionId?: string;
      organizationId: string;
      issueId: string;
      issueIdentifier: string;
      issueUrl: string;
      /** Optional — agent sessions from delegation/assignment have no comment */
      commentId?: string;
      /** Webhook delivery ID for idempotency */
      linearDeliveryId?: string;
    }
  | {
      type: "www-multi-agent";
      models: SelectedAIModels;
    };

/**
 * Write-time metadata type for new linear-mention threads (fn-2+).
 * Requires agentSessionId — use this when creating threads from AgentSessionEvent webhooks.
 * The read-time ThreadSourceMetadata keeps agentSessionId optional for legacy fn-1 compatibility.
 */
export type LinearMentionSourceMetadataInsert = Omit<
  Extract<ThreadSourceMetadata, { type: "linear-mention" }>,
  "agentSessionId"
> & { agentSessionId: string };

export type ThreadStatusDeprecated =
  | "queued-blocked"
  | "error"
  | "stopped"
  | "working-stopped";

export type ThreadStatus =
  // Deprecated
  | ThreadStatusDeprecated
  // User has saved a task as draft, not submitted
  | "draft"
  // User has scheduled a task to run at a later time
  | "scheduled"
  // User has clicked "Send"
  | "queued"
  // Waiting for a sandbox to become available (concurrency limit)
  | "queued-tasks-concurrency"
  // Waiting due to sandbox creation rate limit
  | "queued-sandbox-creation-rate-limit"
  // Waiting due to agent (Claude) rate limit
  | "queued-agent-rate-limit"
  // Sandbox is being provisioned
  | "booting"
  // Agent is running
  | "working"
  // Agent is stopping.
  | "stopping"

  // Agent is done with messages:
  | "working-error"
  | "working-done"

  // Wrapping up
  | "checkpointing"

  // Agent is complete (done with checkpointing)
  | "complete";

export type ThreadErrorType =
  | "request-timeout"
  | "no-user-message"
  | "unknown-error"
  | "sandbox-not-found"
  | "sandbox-creation-failed"
  | "sandbox-resume-failed"
  | "missing-gemini-credentials"
  | "missing-amp-credentials"
  | "chatgpt-sub-required"
  | "invalid-codex-credentials"
  | "invalid-claude-credentials"
  | "agent-not-responding"
  | "agent-generic-error"
  | "git-checkpoint-diff-failed"
  | "git-checkpoint-push-failed"
  | "setup-script-failed"
  | "prompt-too-long"
  | "queue-limit-exceeded";
export type ThreadErrorMessage = ThreadErrorType | string;
export type GithubPRStatus = "draft" | "open" | "closed" | "merged";
export type GithubCheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";
export type GithubCheckRunStatus = "queued" | "in_progress" | "completed";
export type GithubPRMergeableState =
  | "clean" // No conflicts
  | "dirty" // Has conflicts
  | "blocked" // Blocked
  | "unknown" // Unknown state
  | "unstable"; // Unstable state
export type GithubCheckStatus =
  | "none" // No checks
  | "pending" // Checks are running
  | "success" // All checks passed
  | "failure" // One or more checks failed
  | "unknown"; // Unknown state
export interface GitDiffStats {
  files: number;
  additions: number;
  deletions: number;
}
export interface ChildThreadInfo {
  id: string;
  parentToolId: string | null;
}

export type ThreadChatInfoFull = ThreadChat & {
  isUnread: boolean;
};

export type ThreadInfo = Omit<
  Thread,
  | "status"
  | "agent"
  | "agentVersion"
  | "sessionId"
  | "queuedMessages"
  | "errorMessage"
  | "errorMessageInfo"
  | "permissionMode"
  | "reattemptQueueAt"
  | "scheduleAt"
  | "contextLength"
  | "messages"
  | "gitDiff"
> & {
  isUnread: boolean;
  visibility: ThreadVisibility | null;
  prStatus: GithubPRStatus | null;
  prChecksStatus: GithubCheckStatus | null;
  authorName: string | null;
  authorImage: string | null;
  threadChats: Pick<ThreadChat, "id" | "agent" | "status" | "errorMessage">[];
};
export type ThreadInfoFull = Omit<ThreadInfo, "threadChats"> & {
  gitDiff: Thread["gitDiff"];
  parentThreadName: Thread["name"];
  threadChats: ThreadChatInfoFull[];
  childThreads: ChildThreadInfo[];
};

export type AllowedSignup = typeof schema.allowedSignups.$inferSelect;
export type AllowedSignupWithUserId = AllowedSignup & {
  userIdOrNull: string | null;
};

export type SubscriptionRaw = typeof schema.subscription.$inferSelect;
export type SubscriptionInfo = Pick<
  SubscriptionRaw,
  | "id"
  | "plan"
  | "status"
  | "periodEnd"
  | "periodStart"
  | "trialStart"
  | "trialEnd"
  | "cancelAtPeriodEnd"
> & {
  isActive: boolean;
};

export type SubscriptionInsert = typeof schema.subscription.$inferInsert;

export type ThreadInsertRaw = typeof schema.thread.$inferInsert;
export type ThreadChatInsertRaw = typeof schema.threadChat.$inferInsert;

export type ThreadChatInsert = Partial<
  Omit<
    ThreadChatInsertRaw,
    | "messages"
    | "queuedMessages"
    | "errorMessage"
    | "errorMessageInfo"
    | "status"
  > &
    Partial<{
      // Only allow inserting one of our known types.
      errorMessage?: ThreadErrorType | null;
      errorMessageInfo?: ThreadChatInsertRaw["errorMessageInfo"];
      // Explicitly call out that we're appending messages.
      appendMessages?: ThreadChatInsertRaw["messages"];
      replaceMessages?: ThreadChatInsertRaw["messages"];
      // Explicitly call out that we're replacing queued messages.
      replaceQueuedMessages?: ThreadChatInsertRaw["queuedMessages"];
      // Explicitly call out that we're appending queued messages.
      appendQueuedMessages?: ThreadChatInsertRaw["queuedMessages"];
      // Explicitly call out that we're appending and resetting queued messages.
      appendAndResetQueuedMessages?: boolean;
      // Exclude deprecated statuses.
      status?: Exclude<ThreadStatus, ThreadStatusDeprecated>;
    }>
>;

export type ThreadInsert = Omit<
  ThreadInsertRaw,
  | "status"
  | "agent"
  | "agentVersion"
  | "errorMessage"
  | "errorMessageInfo"
  | "messages"
  | "queuedMessages"
  | "sessionId"
  | "reattemptQueueAt"
  | "scheduleAt"
  | "contextLength"
  | "permissionMode"
>;

/**
 * Typed insert for new Linear-agent threads (fn-2+).
 * Constrains sourceType to "linear-mention" and requires agentSessionId in
 * sourceMetadata, preventing accidental omission at compile time.
 * Use this in webhook handlers instead of raw ThreadInsert.
 */
export type LinearMentionThreadInsert = Omit<ThreadInsert, "sourceMetadata"> & {
  sourceType: "linear-mention";
  sourceMetadata: LinearMentionSourceMetadataInsert;
};

export type GitHubPR = typeof schema.githubPR.$inferSelect;
export type GitHubPRInsert = typeof schema.githubPR.$inferInsert;
export type GitHubCheckRun = typeof schema.githubCheckRun.$inferSelect;
export type GitHubCheckRunInsert = typeof schema.githubCheckRun.$inferInsert;

export type FeatureFlagDB = typeof schema.featureFlags.$inferSelect;
export type FeatureFlag = FeatureFlagDB & {
  inCodebase: boolean;
  enabledForPreview: boolean;
};
export type FeatureFlagInsert = typeof schema.featureFlags.$inferInsert;
export type UserFeatureFlag = typeof schema.userFeatureFlags.$inferSelect;
export type UserFeatureFlagInsert = typeof schema.userFeatureFlags.$inferInsert;

export type Automation = typeof schema.automations.$inferSelect;
type AutomationInsertRaw = typeof schema.automations.$inferInsert;

export type AutomationInsert<T = AutomationTriggerType> = Omit<
  AutomationInsertRaw,
  "triggerType" | "triggerConfig"
> & {
  triggerType: T;
  triggerConfig: Extract<AutomationTrigger, { type: T }>["config"];
};

export type UserCreditGrantType =
  | "signup_bonus"
  | "stripe_top_up"
  | "stripe_auto_reload"
  | "admin_adjustment";

export type UsageEventType =
  | "claude_cost_usd"
  | "billable_anthropic_usd"
  | "sandbox_usage_time_application_ms"
  | "sandbox_usage_time_agent_ms"
  | "billable_openai_usd"
  | "billable_openrouter_usd"
  | "billable_google_usd";

export type UsageSku =
  | "openai_responses_gpt_5"
  | "openai_responses_gpt_5_2"
  | "anthropic_messages_sonnet"
  | "anthropic_messages_haiku"
  | "anthropic_messages_opus"
  | "anthropic_messages_opus_4_5"
  | "anthropic_messages_default"
  | "openrouter_qwen"
  | "openrouter_grok"
  | "openrouter_kimi"
  | "openrouter_glm"
  | "openrouter_gemini"
  | "openrouter_gemini_3_pro"
  | "openrouter_default"
  | "google_gemini_2_5_pro"
  | "google_gemini_2_5_flash"
  | "google_gemini_3_pro"
  | "google_default";

export type UsageEvent = typeof schema.usageEvents.$inferSelect;
export type UsageEventInsert = typeof schema.usageEvents.$inferInsert;

export type UserCredit = typeof schema.userCredits.$inferSelect;
export type UserCreditInsert = typeof schema.userCredits.$inferInsert;

export type UserCredentials = {
  hasClaude: boolean;
  hasAmp: boolean;
  hasOpenAI: boolean;
  hasOpenAIOAuthCredentials: boolean;
};

export type SignupTrialInfo = {
  isActive: boolean;
  daysRemaining: number;
  plan: AccessTier;
  trialEndsAt: string; // ISO
};

// Public gating tier used across the app. Trials map to "core" with a trial flag.
export type AccessTier = "none" | "core" | "pro";

export type AccessInfo = {
  tier: AccessTier;
};

export type StripePromotionCode = {
  code: string;
  stripeCouponId: string;
  stripePromotionCodeId: string;
};

export type BillingInfo = {
  hasActiveSubscription: boolean;
  subscription: SubscriptionInfo | null;
  // Signup-based trial (independent of Stripe trials)
  signupTrial: SignupTrialInfo | null;
  unusedPromotionCode: boolean;
  // If true, new subscriptions are blocked (shutdown mode)
  isShutdownMode?: boolean;
};

export type ClaudeAgentProviderMetadata = {
  type: "claude";
  tokenType?: string;
  accountId?: string;
  accountEmail?: string;
  orgId?: string;
  orgName?: string;
  organizationType?: ClaudeOrganizationType;
  scope?: string;
  isMax?: boolean;
  isSubscription?: boolean;
};

export type OpenAIProviderMetadata = {
  type: "openai";
  accountId?: string;
  // These fields are parsed from JWT on-the-fly, not stored
  email?: string;
  planType?: string;
  chatgptAccountId?: string;
};

export type AgentProviderMetadata =
  | ClaudeAgentProviderMetadata
  | OpenAIProviderMetadata;

export type SdlcLoopState =
  | "enrolled"
  | "implementing"
  | "gates_running"
  | "blocked_on_agent_fixes"
  | "blocked_on_ci"
  | "blocked_on_review_threads"
  | "video_pending"
  | "human_review_ready"
  | "video_degraded_ready"
  | "blocked_on_human_feedback"
  | "terminated_pr_closed"
  | "terminated_pr_merged"
  | "done"
  | "stopped";

export type SdlcLoopCauseType =
  | "daemon_terminal"
  | "check_run.completed"
  | "check_suite.completed"
  | "pull_request.synchronize"
  | "pull_request.closed"
  | "pull_request.reopened"
  | "pull_request.edited"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "review-thread-poll-synthetic";

export type SdlcLoopOutboxActionType =
  | "publish_status_comment"
  | "publish_check_summary"
  | "enqueue_fix_task"
  | "publish_video_link"
  | "emit_telemetry";

export type SdlcLoopOutboxSupersessionGroup =
  | "publication_status"
  | "fix_task_enqueue"
  | "publication_video"
  | "telemetry";

export type SdlcLoopOutboxStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type SdlcOutboxAttemptStatus =
  | "completed"
  | "retry_scheduled"
  | "failed";

export type SdlcDeepReviewSeverity = "critical" | "high" | "medium" | "low";

export type SdlcDeepReviewStatus = "passed" | "blocked" | "invalid_output";

export type SdlcCarmackReviewSeverity = "critical" | "high" | "medium" | "low";

export type SdlcCarmackReviewStatus = "passed" | "blocked" | "invalid_output";

export type SdlcCiCapabilityState =
  | "supported"
  | "forbidden"
  | "unsupported"
  | "transient_error";

export type SdlcCiGateStatus = "passed" | "blocked" | "capability_error";

export type SdlcCiRequiredCheckSource =
  | "ruleset"
  | "branch_protection"
  | "allowlist"
  | "no_required";

export type SdlcReviewThreadGateStatus =
  | "passed"
  | "blocked"
  | "transient_error";

export type SdlcReviewThreadEvaluationSource = "webhook" | "polling";

export type SdlcVideoCaptureStatus = "not_started" | "captured" | "failed";

export type SdlcVideoFailureClass = "auth" | "quota" | "script" | "infra";

export type SdlcParityTargetClass = "coordinator";
