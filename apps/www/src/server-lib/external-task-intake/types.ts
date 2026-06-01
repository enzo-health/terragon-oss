import type { DBUserMessage } from "@terragon/shared";
import type {
  Automation,
  LinearMentionSourceMetadataInsert,
  ThreadSource,
  ThreadSourceMetadata,
} from "@terragon/shared/db/types";

export type ExternalTaskIntakeSource =
  | "automation"
  | "github"
  | "linear"
  | "slack";

export type ExternalTaskOwnerReason = string;

export interface LinearExternalActor {
  type: "linear-user";
  id: string;
}

export interface GithubExternalActor {
  type: "github-user";
  accountId: string;
}

export interface SlackExternalActor {
  type: "slack-user";
  id: string;
}

export interface LinearAgentSessionTargetKey {
  type: "linear-agent-session";
  organizationId: string;
  agentSessionId: string;
  issueId?: string | null;
  deliveryId?: string;
}

export interface GithubPullRequestTargetKey {
  type: "github-pr";
  repoFullName: string;
  prNumber: number;
  eventType?: string;
  deliveryId?: string;
}

export interface GithubMentionTargetKey {
  type: "github-mention";
  repoFullName: string;
  issueOrPrNumber: number;
  issueOrPrType: "pull_request" | "issue";
  commentId?: number;
  deliveryId?: string;
}

export interface SlackThreadTargetKey {
  type: "slack-thread";
  teamId: string;
  channel: string;
  threadTs: string;
}

export interface AutomationRunTargetKey {
  type: "automation-run";
  automationId: string;
  triggerType: Automation["triggerType"];
  runSource: "automated" | "manual";
  githubPRNumber?: number;
  githubIssueNumber?: number;
}

interface ExternalTaskIntakeBase {
  source: ExternalTaskIntakeSource;
  ownerUserId: string;
  ownerReason: ExternalTaskOwnerReason;
  externalActor?:
    | GithubExternalActor
    | LinearExternalActor
    | SlackExternalActor;
  targetKey:
    | GithubMentionTargetKey
    | GithubPullRequestTargetKey
    | LinearAgentSessionTargetKey
    | SlackThreadTargetKey
    | AutomationRunTargetKey;
  message: DBUserMessage;
  idempotencyKey?: string;
}

export interface LinearCreateThreadIntakeRequest
  extends ExternalTaskIntakeBase {
  intent: "create-thread";
  source: "linear";
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  sourceType: "linear-mention";
  sourceMetadata: LinearMentionSourceMetadataInsert;
}

export interface GithubCreateThreadIntakeRequest
  extends ExternalTaskIntakeBase {
  intent: "create-thread";
  source: "github";
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  sourceType: ThreadSource;
  sourceMetadata?: ThreadSourceMetadata;
  automation?: Automation;
}

export interface SlackCreateThreadIntakeRequest extends ExternalTaskIntakeBase {
  intent: "create-thread";
  source: "slack";
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  sourceType: "slack-mention";
  sourceMetadata: Extract<ThreadSourceMetadata, { type: "slack-mention" }>;
}

export interface AutomationCreateThreadIntakeRequest
  extends ExternalTaskIntakeBase {
  intent: "create-thread";
  source: "automation";
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  sourceType: "automation";
  automation: Automation;
  disableGitCheckpointing?: boolean;
}

export interface LinearFollowUpIntakeRequest extends ExternalTaskIntakeBase {
  intent: "follow-up";
  source: "linear";
  threadId: string;
  threadChatId: string;
  appendOrReplace: "append" | "replace";
}

export interface GithubFollowUpIntakeRequest extends ExternalTaskIntakeBase {
  intent: "follow-up";
  source: "github";
  threadId: string;
  threadChatId: string;
  appendOrReplace: "append" | "replace";
}

export interface SlackFollowUpIntakeRequest extends ExternalTaskIntakeBase {
  intent: "follow-up";
  source: "slack";
  threadId: string;
  threadChatId: string;
  appendOrReplace: "append" | "replace";
}

export type ExternalTaskIntakeRequest =
  | AutomationCreateThreadIntakeRequest
  | GithubCreateThreadIntakeRequest
  | GithubFollowUpIntakeRequest
  | LinearCreateThreadIntakeRequest
  | LinearFollowUpIntakeRequest
  | SlackCreateThreadIntakeRequest
  | SlackFollowUpIntakeRequest;

export type ExternalTaskIntakeResult =
  | {
      intent: "create-thread";
      threadId: string;
      threadChatId: string;
    }
  | {
      intent: "follow-up";
      threadId: string;
      threadChatId: string;
    };
