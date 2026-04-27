import {
  AgentModelPreferences,
  AIAgent,
  AIModel,
  SelectedAIModels,
} from "@terragon/agent/types";
import type { BootingSubstatus, SandboxStatus } from "@terragon/sandbox/types";
import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import { sql } from "drizzle-orm";
import {
  AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  AutomationAction,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from "../automations";
import type { RuntimeFailureCategory } from "../runtime/failure";
import { DBMessage, DBUserMessage } from "./db-message";
import {
  AgentProviderMetadata,
  AgentRunProtocolVersion,
  AgentRunStatus,
  AgentRuntimeProvider,
  AgentTransportMode,
  ClaudeOrganizationType,
  GitDiffStats,
  GithubCheckStatus,
  GithubInstallationPermissions,
  GithubPRMergeableState,
  GithubPRStatus,
  GithubSurfaceBindingKind,
  GithubSurfaceBindingMetadata,
  GithubSurfaceBindingRoutingReason,
  GithubWorkspaceLane,
  GithubWorkspaceRunStatus,
  ThreadErrorMessage,
  ThreadFailureSource,
  ThreadSource,
  ThreadSourceMetadata,
  ThreadStatus,
  ThreadVisibility,
  UsageEventType,
  UsageSku,
  UserCreditGrantType,
} from "./types";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  // admin plugin fields
  role: text("role"),
  banned: boolean("banned"),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  // Shadow ban limits task creation rate without blocking access
  shadowBanned: boolean("shadow_banned").notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
  signupTrialPlan: text("signup_trial_plan"),
});

export const userStripePromotionCode = pgTable(
  "user_stripe_promotion_code",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stripeCouponId: text("stripe_coupon_id").notNull(),
    stripePromotionCodeId: text("stripe_promotion_code_id").notNull(),
    code: text("code").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    redeemedAt: timestamp("redeemed_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("user_stripe_promotion_code_user_unique").on(table.userId),
    uniqueIndex("user_stripe_promotion_code_code_unique").on(table.code),
    uniqueIndex("user_stripe_promotion_code_promo_unique").on(
      table.stripePromotionCodeId,
    ),
  ],
);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"), // admin plugin field
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const apikey = pgTable("apikey", {
  id: text("id").primaryKey(),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at"),
  enabled: boolean("enabled").default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
  rateLimitMax: integer("rate_limit_max").default(10),
  requestCount: integer("request_count"),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  permissions: text("permissions"),
  metadata: text("metadata"),
});

export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";

export const subscription = pgTable(
  "subscription",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    plan: text("plan").notNull(),
    referenceId: text("reference_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status")
      .$type<SubscriptionStatus>()
      .notNull()
      .default("incomplete"),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    trialStart: timestamp("trial_start"),
    trialEnd: timestamp("trial_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    seats: integer("seats").default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("subscription_reference_id_idx").on(table.referenceId),
    index("subscription_status_idx").on(table.status),
    index("subscription_stripe_subscription_id_idx").on(
      table.stripeSubscriptionId,
    ),
  ],
);

export const waitlist = pgTable(
  "waitlist",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("email_unique").on(table.email)],
);

export const onboardingQuestionnaire = pgTable(
  "onboarding_questionnaire",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    claudeSubscription: text("claude_subscription"),
    participationPreference: text("participation_preference"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("onboarding_email_unique").on(table.email)],
);

export const allowedSignups = pgTable(
  "allowed_signup",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("allowed_signups_email_unique").on(table.email)],
);

const threadChatShared = {
  agent: text("agent").$type<AIAgent>().notNull().default("claudeCode"),
  agentVersion: integer("agent_version").notNull().default(0),
  status: text("status").$type<ThreadStatus>().notNull().default("queued"),
  messages: jsonb("messages").$type<DBMessage[]>(),
  queuedMessages: jsonb("queued_messages").$type<DBUserMessage[]>(),
  sessionId: text("session_id"),
  errorMessage: text("error_message").$type<ThreadErrorMessage>(),
  errorMessageInfo: text("error_message_info"),
  scheduleAt: timestamp("schedule_at"),
  reattemptQueueAt: timestamp("reattempt_queue_at"),
  contextLength: integer("context_length"),
  permissionMode: text("permission_mode")
    .$type<"allowAll" | "plan">()
    .default("allowAll"),
  messageSeq: integer("message_seq").notNull().default(0),
};

export const thread = pgTable(
  "thread",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name"),
    githubRepoFullName: text("github_repo_full_name").notNull(),
    repoBaseBranchName: text("repo_base_branch_name").notNull(),
    branchName: text("current_branch_name"),
    githubPRNumber: integer("github_pr_number"),
    githubIssueNumber: integer("github_issue_number"),
    codesandboxId: text("codesandbox_id"),
    sandboxProvider: text("sandbox_provider")
      .notNull()
      .$type<SandboxProvider>()
      .default("e2b"),
    sandboxSize: text("sandbox_size").$type<SandboxSize>(),
    sandboxStatus: text("sandbox_status").$type<SandboxStatus>(),
    bootingSubstatus: text("booting_substatus").$type<BootingSubstatus>(),
    gitDiff: text("git_diff"),
    gitDiffStats: jsonb("git_diff_stats").$type<GitDiffStats>(),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    automationId: text("automation_id").references(
      (): AnyPgColumn => automations.id,
      { onDelete: "set null" },
    ),
    parentThreadId: text("parent_thread_id").references(
      (): AnyPgColumn => thread.id,
      { onDelete: "set null" },
    ),
    parentToolId: text("parent_tool_id"),
    draftMessage: jsonb("draft_message").$type<DBUserMessage>(),
    disableGitCheckpointing: boolean("disable_git_checkpointing")
      .notNull()
      .default(false),
    skipSetup: boolean("skip_setup").notNull().default(false),
    sourceType: text("source_type").$type<ThreadSource>(),
    sourceMetadata: jsonb("source_metadata").$type<ThreadSourceMetadata>(),
    // Thread version:
    // 0: One thread -> chat information is part of the thread
    // 1: One thread -> can have multiple thread chats, chat information is separate from the thread
    version: integer("version").notNull().default(0),
    ...threadChatShared,
  },
  (table) => [
    index("user_id_index").on(table.userId),
    index("user_id_created_at_index").on(table.userId, table.createdAt),
    index("user_id_updated_at_index").on(table.userId, table.updatedAt),
    index("user_id_status_index").on(table.userId, table.status),
    index("user_id_archived_index").on(table.userId, table.archived),
    index("parent_thread_id_index").on(table.parentThreadId),
    index("user_id_automation_id_index").on(table.userId, table.automationId),
    index("github_repo_full_name_github_pr_number_index").on(
      table.githubRepoFullName,
      table.githubPRNumber,
    ),
    index("schedule_at_status_index").on(table.scheduleAt, table.status),
    index("reattempt_queue_at_status_index").on(
      table.reattemptQueueAt,
      table.status,
    ),
    index("source_type_index").on(table.sourceType),
    index("sandbox_provider_and_id_index").on(
      table.sandboxProvider,
      table.codesandboxId,
    ),
  ],
);

export const threadChat = pgTable(
  "thread_chat",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ...threadChatShared,
    codexPreviousResponseId: text("codex_previous_response_id"),
  },
  (table) => [
    index("thread_chat_user_id_thread_id_index").on(
      table.userId,
      table.threadId,
    ),
  ],
);

export const agentRunContext = pgTable(
  "agent_run_context",
  {
    runId: text("run_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    threadChatId: text("thread_chat_id").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    transportMode: text("transport_mode")
      .$type<AgentTransportMode>()
      .notNull()
      .default("legacy"),
    protocolVersion: integer("protocol_version")
      .$type<AgentRunProtocolVersion>()
      .notNull()
      .default(1),
    agent: text("agent").$type<AIAgent>().notNull(),
    permissionMode: text("permission_mode")
      .$type<"allowAll" | "plan">()
      .notNull()
      .default("allowAll"),
    requestedSessionId: text("requested_session_id"),
    resolvedSessionId: text("resolved_session_id"),
    runtimeProvider: text("runtime_provider").$type<AgentRuntimeProvider>(),
    externalSessionId: text("external_session_id"),
    previousResponseId: text("previous_response_id"),
    checkpointPointer: text("checkpoint_pointer"),
    hibernationValid: boolean("hibernation_valid"),
    compactionGeneration: integer("compaction_generation"),
    lastAcceptedSeq: bigint("last_accepted_seq", { mode: "number" }),
    terminalEventId: text("terminal_event_id"),
    status: text("status").$type<AgentRunStatus>().notNull().default("pending"),
    failureCategory: text("failure_category").$type<RuntimeFailureCategory>(),
    failureSource: text("failure_source").$type<ThreadFailureSource>(),
    failureRetryable: boolean("failure_retryable"),
    failureSignatureHash: integer("failure_signature_hash"),
    failureTerminalReason: text("failure_terminal_reason"),
    tokenNonce: text("token_nonce").notNull(),
    daemonTokenKeyId: text("daemon_token_key_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_run_context_thread_chat_id_idx").on(
      table.threadId,
      table.threadChatId,
    ),
    index("agent_run_context_thread_chat_updated_at_idx").on(
      table.threadId,
      table.threadChatId,
      table.updatedAt,
    ),
    index("agent_run_context_runtime_session_idx").on(
      table.runtimeProvider,
      table.externalSessionId,
    ),
    index("agent_run_context_sandbox_id_idx").on(table.sandboxId),
    index("agent_run_context_status_idx").on(table.status),
  ],
);

export const agentEventLog = pgTable(
  "agent_event_log",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    logSeq: bigserial("log_seq", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    threadChatId: text("thread_chat_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    category: text("category").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull(),
    threadChatMessageSeq: integer("thread_chat_message_seq"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_event_log_log_seq_unique").on(table.logSeq),
    uniqueIndex("agent_event_log_run_event_unique").on(
      table.runId,
      table.eventId,
    ),
    uniqueIndex("agent_event_log_thread_chat_seq_unique").on(
      table.threadChatId,
      table.seq,
    ),
    index("agent_event_log_run_seq_idx").on(table.runId, table.seq),
    index("agent_event_log_thread_log_seq_idx").on(
      table.threadId,
      table.logSeq,
    ),
    index("agent_event_log_thread_chat_log_seq_idx").on(
      table.threadChatId,
      table.logSeq,
    ),
    index("agent_event_log_thread_replay_seq_idx").on(
      table.threadId,
      table.threadChatMessageSeq,
    ),
    index("agent_event_log_thread_chat_replay_seq_idx").on(
      table.threadChatId,
      table.threadChatMessageSeq,
    ),
    index("agent_event_log_timestamp_idx").on(table.timestamp),
  ],
);

export const threadVisibility = pgTable(
  "thread_visibility",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text("thread_id")
      .notNull()
      .unique()
      .references(() => thread.id, {
        onDelete: "cascade",
      }),
    visibility: text("visibility").$type<ThreadVisibility>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("thread_visibility_thread_id_index").on(table.threadId)],
);

export const githubInstallationProjection = pgTable(
  "github_installation_projection",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    targetAccountId: bigint("target_account_id", { mode: "number" }),
    targetAccountLogin: text("target_account_login"),
    targetAccountType: text("target_account_type"),
    permissionsJson:
      jsonb("permissions_json").$type<GithubInstallationPermissions>(),
    isSuspended: boolean("is_suspended").notNull().default(false),
    suspendedAt: timestamp("suspended_at"),
    lastWebhookReceivedAt: timestamp("last_webhook_received_at"),
    lastWebhookSucceededAt: timestamp("last_webhook_succeeded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("github_installation_projection_installation_id_unique").on(
      table.installationId,
    ),
    unique("github_installation_projection_id_installation_id_unique").on(
      table.id,
      table.installationId,
    ),
  ],
);

export const githubRepoProjection = pgTable(
  "github_repo_projection",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    installationProjectionId: text("installation_projection_id").notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    repoNodeId: text("repo_node_id"),
    currentSlug: text("current_slug").notNull(),
    defaultBranch: text("default_branch"),
    isPrivate: boolean("is_private").notNull().default(false),
    hasReadAccess: boolean("has_read_access").notNull().default(false),
    hasWriteAccess: boolean("has_write_access").notNull().default(false),
    hasAdminAccess: boolean("has_admin_access").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("github_repo_projection_repo_id_unique").on(table.repoId),
    unique("github_repo_projection_id_repo_id_unique").on(
      table.id,
      table.repoId,
    ),
    index("github_repo_projection_installation_id_index").on(
      table.installationId,
    ),
    index("github_repo_projection_installation_projection_id_index").on(
      table.installationProjectionId,
    ),
    index("github_repo_projection_current_slug_index").on(table.currentSlug),
    foreignKey({
      columns: [table.installationProjectionId, table.installationId],
      foreignColumns: [
        githubInstallationProjection.id,
        githubInstallationProjection.installationId,
      ],
      name: "github_repo_projection_installation_projection_id_installation_id_fk",
    }).onDelete("cascade"),
  ],
);

export const githubPrProjection = pgTable(
  "github_pr_projection",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repoProjectionId: text("repo_projection_id").notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    prNodeId: text("pr_node_id").notNull(),
    number: integer("number").notNull(),
    status: text("status").$type<GithubPRStatus>().notNull().default("open"),
    isDraft: boolean("is_draft").notNull().default(false),
    baseRef: text("base_ref"),
    headRef: text("head_ref"),
    headSha: text("head_sha"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("github_pr_projection_pr_node_id_unique").on(table.prNodeId),
    unique("github_pr_projection_id_repo_id_unique").on(table.id, table.repoId),
    uniqueIndex("github_pr_projection_repo_id_number_unique").on(
      table.repoId,
      table.number,
    ),
    index("github_pr_projection_repo_projection_id_index").on(
      table.repoProjectionId,
    ),
    foreignKey({
      columns: [table.repoProjectionId, table.repoId],
      foreignColumns: [githubRepoProjection.id, githubRepoProjection.repoId],
      name: "github_pr_projection_repo_projection_id_repo_id_fk",
    }).onDelete("cascade"),
    check(
      "github_pr_projection_status_is_draft_consistent",
      sql`(("status" = 'draft' AND "is_draft" = true) OR ("status" <> 'draft' AND "is_draft" = false))`,
    ),
  ],
);

export const githubPrWorkspace = pgTable(
  "github_pr_workspace",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    installationProjectionId: text("installation_projection_id").notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repoProjectionId: text("repo_projection_id").notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    prProjectionId: text("pr_projection_id").notNull(),
    prNodeId: text("pr_node_id").notNull(),
    prNumber: integer("pr_number").notNull(),
    status: text("status").$type<GithubPRStatus>().notNull().default("open"),
    headSha: text("head_sha"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("github_pr_workspace_pr_projection_id_unique").on(
      table.prProjectionId,
    ),
    uniqueIndex("github_pr_workspace_installation_repo_pr_node_id_unique").on(
      table.installationId,
      table.repoId,
      table.prNodeId,
    ),
    index("github_pr_workspace_installation_projection_id_index").on(
      table.installationProjectionId,
    ),
    index("github_pr_workspace_repo_projection_id_index").on(
      table.repoProjectionId,
    ),
    index("github_pr_workspace_pr_projection_id_index").on(
      table.prProjectionId,
    ),
    foreignKey({
      columns: [table.installationProjectionId, table.installationId],
      foreignColumns: [
        githubInstallationProjection.id,
        githubInstallationProjection.installationId,
      ],
      name: "github_pr_workspace_installation_projection_id_installation_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.repoProjectionId, table.repoId],
      foreignColumns: [githubRepoProjection.id, githubRepoProjection.repoId],
      name: "github_pr_workspace_repo_projection_id_repo_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.prProjectionId, table.repoId],
      foreignColumns: [githubPrProjection.id, githubPrProjection.repoId],
      name: "github_pr_workspace_pr_projection_id_repo_id_fk",
    }).onDelete("cascade"),
  ],
);

export const githubSurfaceBinding = pgTable(
  "github_surface_binding",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => githubPrWorkspace.id, { onDelete: "cascade" }),
    surfaceKind: text("surface_kind")
      .$type<GithubSurfaceBindingKind>()
      .notNull(),
    surfaceGitHubId: text("surface_github_id").notNull(),
    surfaceMetadata:
      jsonb("surface_metadata").$type<GithubSurfaceBindingMetadata>(),
    lane: text("lane").$type<GithubWorkspaceLane>().notNull(),
    routingReason: text("routing_reason")
      .$type<GithubSurfaceBindingRoutingReason>()
      .notNull(),
    boundHeadSha: text("bound_head_sha").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex(
      "github_surface_binding_surface_kind_surface_github_id_unique",
    ).on(table.surfaceKind, table.surfaceGitHubId),
    check(
      "github_surface_binding_surface_metadata_kind_check",
      sql`
        (
          "surface_kind" = 'issue_comment_mention'
          AND "surface_metadata" IS NOT NULL
        )
        OR (
          "surface_kind" <> 'issue_comment_mention'
          AND "surface_metadata" IS NULL
        )
      `,
    ),
    index("github_surface_binding_workspace_id_index").on(table.workspaceId),
  ],
);

export const githubPR = pgTable(
  "github_pr",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    status: text("status").$type<GithubPRStatus>().notNull().default("open"),
    baseRef: text("base_ref"),
    mergeableState: text("mergeable_state")
      .$type<GithubPRMergeableState>()
      .default("unknown"),
    checksStatus: text("checks_status")
      .$type<GithubCheckStatus>()
      .default("unknown"),
    threadId: text("thread_id").references(() => thread.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("repo_number_unique").on(table.repoFullName, table.number),
  ],
);

export const userSettings = pgTable(
  "user_settings",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    autoCreatePRs: boolean("auto_create_draft_prs").notNull().default(true),
    autoArchiveMergedPRs: boolean("auto_archive_merged_prs")
      .notNull()
      .default(true),
    autoClosePRsOnArchive: boolean("auto_close_draft_prs_on_archive")
      .notNull()
      .default(false),
    branchNamePrefix: text("branch_name_prefix").notNull().default("terragon/"),
    prType: text("pr_type")
      .$type<"draft" | "ready">()
      .notNull()
      .default("draft"),
    sandboxProvider: text("sandbox_provider")
      .$type<SandboxProvider | "default">()
      .notNull()
      .default("default"),
    sandboxSize: text("sandbox_size").$type<SandboxSize>(),
    customSystemPrompt: text("custom_system_prompt"),
    defaultThreadVisibility: text("default_thread_visibility")
      .$type<ThreadVisibility>()
      .notNull()
      .default("repo"),
    // Opt-in to early Preview features
    previewFeaturesOptIn: boolean("preview_features_opt_in")
      .notNull()
      .default(false),
    singleThreadForGitHubMentions: boolean("single_thread_for_github_mentions")
      .notNull()
      .default(true),
    defaultGitHubMentionModel: text(
      "default_github_mention_model",
    ).$type<AIModel>(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    autoReloadDisabled: boolean("auto_reload_disabled")
      .notNull()
      .default(false),
    agentModelPreferences: jsonb(
      "agent_model_preferences",
    ).$type<AgentModelPreferences>(),
  },
  (table) => [uniqueIndex("user_id_unique").on(table.userId)],
);

export type EnvironmentSnapshot = {
  provider: "daytona";
  size: SandboxSize;
  snapshotName: string;
  status: "building" | "ready" | "failed" | "stale";
  setupScriptHash: string;
  baseDockerfileHash: string;
  environmentVariablesHash?: string;
  mcpConfigHash?: string;
  error?: string;
  builtAt: string;
};

// Each user + repo combination has an environment.
export const environment = pgTable(
  "environment",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    isGlobal: boolean("is_global").notNull().default(false),
    repoFullName: text("repo_full_name").notNull(),
    environmentVariables: jsonb("environment_variables")
      .$type<Array<{ key: string; valueEncrypted: string }>>()
      .default([]),
    mcpConfigEncrypted: text("mcp_config_encrypted"),
    setupScript: text("setup_script"),
    snapshots: jsonb("snapshots").$type<EnvironmentSnapshot[]>().default([]),
    DEPRECATED_disableGitCheckpointing: boolean("disable_git_checkpointing")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("user_id_repo_full_name_branch_name_unique").on(
      table.userId,
      table.repoFullName,
    ),
  ],
);

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const claudeOAuthTokens_DEPRECATED = pgTable("claude_oauth_tokens", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  isSubscription: boolean("is_subscription").notNull().default(true),
  anthropicApiKeyEncrypted: text("anthropic_api_key_encrypted"),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  tokenType: text("token_type").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }), // Calculated from expires_in
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  scope: text("scope"),
  isMax: boolean("is_max").default(false).notNull(), // Cache Claude Max status
  organizationType: text("organization_type").$type<ClaudeOrganizationType>(),
  accountId: text("account_id"),
  accountEmail: text("account_email"),
  orgId: text("org_id"),
  orgName: text("org_name"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const geminiAuth_DEPRECATED = pgTable("gemini_auth", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  tokenType: text("token_type").$type<"oauth" | "apiKey">().notNull(),
  geminiApiKeyEncrypted: text("gemini_api_key_encrypted"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const ampAuth_DEPRECATED = pgTable("amp_auth", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  ampApiKeyEncrypted: text("amp_api_key_encrypted"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const openAIAuth_DEPRECATED = pgTable("openai_auth", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  openAIApiKeyEncrypted: text("openai_api_key_encrypted"),
  // OAuth tokens for Codex credentials
  accessTokenEncrypted: text("access_token_encrypted"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  idTokenEncrypted: text("id_token_encrypted"),
  accountId: text("account_id"),
  expiresAt: timestamp("expires_at", { mode: "date" }),
  lastRefreshedAt: timestamp("last_refreshed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const slackInstallation = pgTable(
  "slack_installation",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    teamId: text("team_id").notNull().unique(), // Slack workspace ID
    teamName: text("team_name").notNull(),
    botUserId: text("bot_user_id").notNull(), // Bot user ID for mentions
    botAccessTokenEncrypted: text("bot_access_token_encrypted").notNull(), // xoxb- token
    scope: text("scope").notNull(), // Bot scopes (app_mentions:read, chat:write, etc.)
    appId: text("app_id").notNull(),
    installerUserId: text("installer_user_id"), // Slack user who installed
    isEnterpriseInstall: boolean("is_enterprise_install")
      .default(false)
      .notNull(),
    enterpriseId: text("enterprise_id"),
    enterpriseName: text("enterprise_name"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("slack_installation_team_id").on(table.teamId)],
);

export const slackAccount = pgTable(
  "slack_account",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    slackUserId: text("slack_user_id").notNull().unique(),
    slackTeamName: text("slack_team_name").notNull(),
    slackTeamDomain: text("slack_team_domain").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("slack_account_user_team_unique").on(
      table.userId,
      table.teamId,
    ),
    uniqueIndex("slack_account_slack_user_team_unique").on(
      table.slackUserId,
      table.teamId,
    ),
  ],
);

export const slackSettings = pgTable(
  "slack_settings",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    defaultRepoFullName: text("default_repo_full_name"),
    defaultModel: text("default_model").$type<AIModel>(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("slack_settings_user_team_unique").on(
      table.userId,
      table.teamId,
    ),
  ],
);

export const linearAccount = pgTable(
  "linear_account",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    linearUserId: text("linear_user_id").notNull(),
    linearUserName: text("linear_user_name").notNull(),
    linearUserEmail: text("linear_user_email").notNull(),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("linear_account_user_org_unique").on(
      table.userId,
      table.organizationId,
    ),
    uniqueIndex("linear_account_linear_user_org_unique").on(
      table.linearUserId,
      table.organizationId,
    ),
  ],
);

export const linearSettings = pgTable(
  "linear_settings",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    defaultRepoFullName: text("default_repo_full_name"),
    defaultModel: text("default_model").$type<AIModel>(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("linear_settings_user_org_unique").on(
      table.userId,
      table.organizationId,
    ),
  ],
);

export const linearInstallation = pgTable(
  "linear_installation",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    organizationId: text("organization_id").notNull().unique(), // Linear workspace/org ID
    organizationName: text("organization_name").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"), // nullable — some installs may not receive refresh token
    tokenExpiresAt: timestamp("token_expires_at", { mode: "date" }),
    scope: text("scope").notNull(),
    installerUserId: text("installer_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  // organizationId already has a unique constraint — no need for an extra index
  () => [],
);

export const threadReadStatus = pgTable(
  "thread_read_status",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    isRead: boolean("is_read").notNull().default(true),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_thread_unique").on(table.threadId, table.userId),
  ],
);

export const threadChatReadStatus = pgTable(
  "thread_chat_read_status",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    threadChatId: text("thread_chat_id")
      .notNull()
      .references(() => threadChat.id, { onDelete: "cascade" }),
    isRead: boolean("is_read").notNull().default(true),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("user_thread_chat_thread_id_user_id_index").on(
      table.threadId,
      table.userId,
    ),
    uniqueIndex("user_thread_chat_unique").on(
      table.userId,
      table.threadId,
      table.threadChatId,
    ),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").$type<"bug" | "feature" | "feedback">().notNull(),
    message: text("message").notNull(),
    currentPage: text("current_page").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("feedback_user_id_index").on(table.userId),
    index("feedback_type_index").on(table.type),
    index("feedback_resolved_index").on(table.resolved),
  ],
);

export const userFlags = pgTable(
  "user_flags",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    hasSeenOnboarding: boolean("has_seen_onboarding").notNull().default(false),
    showDebugTools: boolean("show_debug_tools").notNull().default(false),
    isClaudeMaxSub: boolean("is_claude_max_sub").notNull().default(false),
    isClaudeSub: boolean("is_claude_sub").notNull().default(false),
    claudeOrganizationType: text(
      "claude_organization_type",
    ).$type<ClaudeOrganizationType>(),
    selectedModel: text("selected_model").$type<AIModel>(),
    selectedModels: jsonb("selected_models").$type<SelectedAIModels>(),
    multiAgentMode: boolean("multi_agent_mode").notNull().default(false),
    selectedRepo: text("selected_repo"),
    selectedBranch: text("selected_branch"),
    lastSeenReleaseNotesVersion: integer("last_seen_release_notes_version"),
    // Reserved metadata for feature-upgrade notification tracking.
    lastSeenFeatureUpsellVersion: integer("last_seen_feature_upsell_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("user_flags_user_id_unique").on(table.userId)],
);

// This table is used to store user info that is only available on the server side.
export const userInfoServerSide = pgTable(
  "user_info_server_side",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    autoReloadLastAttemptAt: timestamp("auto_reload_last_attempt_at"),
    autoReloadLastFailureAt: timestamp("auto_reload_last_failure_at"),
    autoReloadLastFailureCode: text("auto_reload_last_failure_code"),
    stripeCreditPaymentMethodId: text("stripe_credit_payment_method_id"),
  },
  (table) => [
    uniqueIndex("user_info_server_side_user_id_unique").on(table.userId),
  ],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    defaultValue: boolean("default_value").notNull(),
    globalOverride: boolean("global_override"),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("name_unique").on(table.name)],
);

export const userFeatureFlags = pgTable(
  "user_feature_flags",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    featureFlagId: text("feature_flag_id")
      .notNull()
      .references(() => featureFlags.id, { onDelete: "cascade" }),
    value: boolean("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_id_feature_flag_id_unique").on(
      table.userId,
      table.featureFlagId,
    ),
  ],
);

export const accessCodes = pgTable(
  "access_codes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text("code").notNull(),
    email: text("email"), // Optional: specific email this code is for
    usedByEmail: text("used_by_email"), // Optional: email of the user who used the code
    usedAt: timestamp("used_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("access_code_unique").on(table.code),
    index("access_codes_expires_at_index").on(table.expiresAt),
    index("access_codes_created_by_user_id_index").on(table.createdByUserId),
  ],
);

export const reengagementEmails = pgTable(
  "reengagement_emails",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    accessCodeId: text("access_code_id")
      .notNull()
      .references(() => accessCodes.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    sentByUserId: text("sent_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("reengagement_email_access_code_unique").on(
      table.email,
      table.accessCodeId,
    ),
    index("reengagement_emails_email_index").on(table.email),
    index("reengagement_emails_sent_at_index").on(table.sentAt),
  ],
);

export const onboardingCompletionEmails = pgTable(
  "onboarding_completion_emails",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    sentByUserId: text("sent_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("onboarding_completion_email_user_unique").on(table.userId),
    index("onboarding_completion_emails_sent_at_index").on(table.sentAt),
  ],
);

export const automations = pgTable(
  "automations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    triggerType: text("trigger_type").$type<AutomationTriggerType>().notNull(),
    triggerConfig: jsonb("trigger_config")
      .$type<AutomationTriggerConfig>()
      .notNull(),
    repoFullName: text("repo_full_name").notNull(),
    branchName: text("branch_name").notNull(),
    action: jsonb("action").$type<AutomationAction>().notNull(),
    skipSetup: boolean("skip_setup").notNull().default(false),
    disableGitCheckpointing: boolean("disable_git_checkpointing")
      .notNull()
      .default(false),
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    runCount: integer("run_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("automations_user_id_index").on(table.userId),
    index("automations_user_id_enabled_index").on(table.userId, table.enabled),
    index("automations_trigger_type_index").on(table.triggerType),
    index("automations_pull_request_repo_full_name_index").on(
      table.triggerType,
      table.repoFullName,
    ),
    index("automations_next_run_at_index").on(table.nextRunAt),
  ],
);

export const userCredits = pgTable(
  "user_credits",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    description: text("description"),
    referenceId: text("reference_id"),
    grantType: text("grant_type").$type<UserCreditGrantType>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("user_credits_user_id_index").on(table.userId),
    uniqueIndex("user_credits_reference_id_unique").on(table.referenceId),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<UsageEventType>().notNull(),
    value: numeric("value").notNull(),
    sku: text("sku").$type<UsageSku>(),
    // Tokens that are billed at the normal input rate
    inputTokens: integer("input_tokens"),
    // Tokens that are billed at the cache hit rate
    cachedInputTokens: integer("cached_input_tokens"),
    // Tokens that are billed at the cache creation rate
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    // Tokens that are billed at the output rate
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("usage_events_user_id_index").on(table.userId),
    index("usage_events_user_id_created_at_index").on(
      table.userId,
      table.createdAt,
    ),
    index("usage_events_user_id_sku_index").on(table.userId, table.sku),
    // tail-scan & aggregation index
    index("usage_events_user_sku_type_ts_id_idx").on(
      table.userId,
      table.sku,
      table.eventType,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Stores running totals of usage per (user, sku, eventType),
 * plus a (created_at, id) watermark to allow incremental catch-ups.
 */
export const usageEventsAggCacheSku = pgTable(
  "usage_events_agg_cache_sku",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    sku: text("sku").$type<UsageSku>().notNull(),
    eventType: text("event_type").$type<UsageEventType>().notNull(),
    inputTokens: bigint("input_tokens", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),
    outputTokens: bigint("output_tokens", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    lastUsageTs: timestamp("last_usage_ts", { withTimezone: true }),
    lastUsageId: text("last_usage_id").references(() => usageEvents.id, {
      onDelete: "cascade",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // unique per (user, sku, event_type)
    uniqueIndex("usage_events_agg_cache_sku_user_sku_event_type_unique").on(
      t.userId,
      t.sku,
      t.eventType,
    ),
    index("usage_events_agg_cache_sku_user_index").on(t.userId),
    index("usage_events_agg_cache_sku_user_sku_index").on(t.userId, t.sku),
  ],
);

export const claudeSessionCheckpoints = pgTable(
  "claude_session_checkpoints",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("claude_session_unique").on(table.threadId, table.sessionId),
  ],
);

export const agentProviderCredentials = pgTable(
  "agent_provider_credentials",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agent: text("agent").$type<AIAgent>().notNull(),
    type: text("type").$type<"api-key" | "oauth">().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    apiKeyEncrypted: text("api_key_encrypted"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    idTokenEncrypted: text("id_token_encrypted"),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    lastRefreshedAt: timestamp("last_refreshed_at", { mode: "date" }),
    metadata: jsonb("metadata").$type<AgentProviderMetadata>(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_provider_credentials_user_id_index").on(table.userId),
    index("agent_provider_credentials_user_agent_index").on(
      table.userId,
      table.agent,
    ),
  ],
);

export const githubWebhookDeliveries = pgTable("github_webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  claimantToken: text("claimant_token").notNull(),
  claimExpiresAt: timestamp("claim_expires_at", { mode: "date" }).notNull(),
  completedAt: timestamp("completed_at", { mode: "date" }),
  eventType: text("event_type"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Idempotency store for Linear webhook deliveries.
 *
 * Lifecycle:
 *   INSERT with completedAt=NULL → delivery claimed by first handler
 *   UPDATE SET completedAt=now(), threadId=<id> → thread creation succeeded
 *
 * On retry (INSERT ON CONFLICT):
 *   - completedAt IS NOT NULL → already processed; skip.
 *   - completedAt IS NULL     → first handler crashed mid-creation; allow retry.
 */
export const linearWebhookDeliveries = pgTable("linear_webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  completedAt: timestamp("completed_at", { mode: "date" }), // null = in-progress/failed
  threadId: text("thread_id"), // set once thread is created
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const githubWorkspaceRun = pgTable(
  "github_workspace_run",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => githubPrWorkspace.id, { onDelete: "cascade" }),
    lane: text("lane").$type<GithubWorkspaceLane>().notNull(),
    headSha: text("head_sha").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status")
      .$type<GithubWorkspaceRunStatus>()
      .notNull()
      .default("pending"),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex(
      "github_workspace_run_workspace_lane_head_sha_attempt_unique",
    ).on(table.workspaceId, table.lane, table.headSha, table.attempt),
    index("github_workspace_run_workspace_id_index").on(table.workspaceId),
    index("github_workspace_run_thread_id_index").on(table.threadId),
    check("github_workspace_run_attempt_positive", sql`"attempt" > 0`),
  ],
);
