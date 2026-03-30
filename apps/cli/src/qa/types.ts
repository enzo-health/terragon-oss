/**
 * QA Validator Core
 *
 * Validates that UI state, database state, and container state agree.
 * Reports discrepancies as structured bug indicators.
 */

export type SourceName = "ui" | "database" | "container";

export type DiscrepancySeverity = "info" | "warning" | "critical";

export type DiscrepancyType =
  | "ui_stale_cache" // UI showing old data
  | "database_ui_mismatch" // UI and DB have different states
  | "container_db_mismatch" // Container state doesn't match DB
  | "event_journal_gap" // Missing events in journal
  | "hydration_mismatch" // SSR vs client data differ
  | "optimistic_update_stuck" // Optimistic state not reverted
  | "websocket_message_loss" // Missed real-time update
  | "timezone_drift" // Timestamp inconsistencies
  | "workflow_version_skew" // Head version doesn't match journal
  | "gate_status_mismatch" // Gate state inconsistent with checks
  | "pr_state_mismatch"; // PR status doesn't match workflow

export interface SourceSnapshot<T = unknown> {
  name: SourceName;
  fetchedAt: Date;
  durationMs: number;
  data: T | null; // Allow null for error cases
  error?: string;
}

export interface Discrepancy {
  id: string;
  timestamp: Date;
  severity: DiscrepancySeverity;
  type: DiscrepancyType;
  threadId: string;
  sources: SourceSnapshot[]; // Changed from [SourceSnapshot, SourceSnapshot] to allow variable length
  field?: string; // Which field differs (e.g., "state", "version")
  description: string;
  impact: string;
  recommendedFix?: string;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  threadId: string;
  verifiedAt: Date;
  durationMs: number;
  sources: {
    ui?: SourceSnapshot;
    database?: SourceSnapshot;
    container?: SourceSnapshot;
  };
  discrepancies: Discrepancy[];
  isHealthy: boolean;
  summary: {
    infoCount: number;
    warningCount: number;
    criticalCount: number;
    totalCount: number;
  };
}

export interface ValidatorConfig {
  threadId: string;
  includeUI: boolean;
  includeDatabase: boolean;
  includeContainer: boolean;
  timeoutMs: number;
  deepMode: boolean; // Include event journal replay
}

// Database schema types (subset we care about)
export interface DatabaseWorkflowState {
  workflowId: string;
  threadId: string;
  state: string;
  activeGate: string | null;
  headSha: string | null;
  activeRunId: string | null;
  version: number;
  generation: number;
  fixAttemptCount: number;
  infraRetryCount: number;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface DatabaseThreadState {
  id: string;
  status: string;
  name: string | null;
  currentBranchName: string | null;
  repoBaseBranchName: string | null;
  githubPrNumber: number | null;
  githubRepoFullName: string | null;
  sandboxProvider: "docker" | "e2b" | "daytona" | string;
  codesandboxId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseEventJournal {
  events: Array<{
    id: string;
    eventType: string;
    occurredAt: string;
    idempotencyKey: string | null;
  }>;
  maxVersion: number;
}

// UI/API schema types (matching server action output)
export interface UIWorkflowState {
  loopId: string;
  state: string;
  planApprovalPolicy: "auto" | "human_required";
  stateLabel: string;
  explanation: string;
  progressPercent: number;
  actions: {
    canResume: boolean;
    canBypassOnce: boolean;
    canApprovePlan: boolean;
  };
  phases: Array<{
    key: string;
    label: string;
    status: string;
  }>;
  checks: Array<{
    key: string;
    label: string;
    status: string;
    detail: string;
  }>;
  needsAttention: {
    isBlocked: boolean;
    blockerCount: number;
    topBlockers: Array<{
      title: string;
      source: string;
    }>;
  };
  links: {
    pullRequestUrl: string | null;
    statusCommentUrl: string | null;
    checkRunUrl: string | null;
  };
  artifacts: {
    planningArtifact: {
      id: string;
      status: string;
      updatedAtIso: string;
      planText: string | null;
    } | null;
    implementationArtifact: {
      id: string;
      status: string;
      headSha: string | null;
      updatedAtIso: string;
    } | null;
    plannedTaskSummary: {
      total: number;
      done: number;
      remaining: number;
    };
    plannedTasks: Array<{
      stableTaskId: string;
      title: string;
      description: string | null;
      acceptance: string[];
      status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
    }>;
  };
  updatedAtIso: string;
}

// Container schema types
export interface ContainerState {
  provider: "docker" | "e2b" | "daytona";
  sandboxId: string;
  status: "running" | "paused" | "exited" | "unknown";
  daemonRunning: boolean;
  daemonPid: number | null;
  lastLogTimestamp: string | null;
  error?: string; // Error message if container fetch failed
  resourceUsage?: {
    cpuPercent: number;
    memoryPercent: number;
  };
  gitStatus?: {
    branch: string;
    headSha: string;
    hasUncommittedChanges: boolean;
  };
  workspacePath: string;
}

// Unified state view (normalized across sources)
export interface NormalizedState {
  threadId: string;
  workflowId: string;
  state: string;
  stateTimestamp: string;
  version: number;
  isActive: boolean;
  hasContainer: boolean;
  hasPR: boolean;
  prNumber?: number;
  headSha?: string;
  activeGate?: string;
  blockers: string[];
}
