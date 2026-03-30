/**
 * Database Source Fetcher
 *
 * Direct PostgreSQL queries for ground truth.
 * Uses the same connection logic as delivery-loop-local-framework.ts
 * NOTE: This uses pg directly (not Drizzle) to keep the CLI lightweight
 * and avoid circular dependencies with @terragon/shared
 */

import { Client } from "pg";
import type {
  SourceSnapshot,
  DatabaseWorkflowState,
  DatabaseThreadState,
  DatabaseEventJournal,
} from "../types.js";

export interface DatabaseConfig {
  connectionString: string;
  timeoutMs: number;
}

/** Sanitize UUID for use in database queries */
export function sanitizeUuid(id: string): string {
  // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  // Allow alphanumeric and hyphens only
  const sanitized = id.replace(/[^a-zA-Z0-9-]/g, "");
  if (sanitized !== id || !/^[0-9a-fA-F-]{36}$/.test(sanitized)) {
    throw new Error(`Invalid UUID format: ${id}`);
  }
  return sanitized;
}

export class DatabaseSourceFetcher {
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async fetchWorkflowState(
    threadId: string,
  ): Promise<SourceSnapshot<DatabaseWorkflowState>> {
    const startTime = Date.now();

    // Validate thread ID format (UUID)
    const safeThreadId = sanitizeUuid(threadId);

    const client = new Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.timeoutMs,
    });

    try {
      await client.connect();

      // Get the active workflow for this thread
      const workflowResult = await client.query(
        `SELECT 
          w.id as "workflowId",
          w.thread_id as "threadId",
          h.state,
          h.active_gate as "activeGate",
          h.head_sha as "headSha",
          h.active_run_id as "activeRunId",
          h.version,
          h.generation,
          h.fix_attempt_count as "fixAttemptCount",
          h.infra_retry_count as "infraRetryCount",
          h.blocked_reason as "blockedReason",
          h.created_at as "createdAt",
          h.updated_at as "updatedAt",
          h.last_activity_at as "lastActivityAt"
         FROM delivery_workflow w
         JOIN delivery_workflow_head_v3 h ON w.id = h.workflow_id
         WHERE w.thread_id = $1
         ORDER BY w.created_at DESC
         LIMIT 1`,
        [safeThreadId],
      );

      if (workflowResult.rows.length === 0) {
        throw new Error(`No workflow found for thread ${safeThreadId}`);
      }

      const data = workflowResult.rows[0] as DatabaseWorkflowState;

      return {
        name: "database",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data,
      };
    } finally {
      await client.end();
    }
  }

  async fetchThreadState(
    threadId: string,
  ): Promise<SourceSnapshot<DatabaseThreadState>> {
    const startTime = Date.now();

    // Validate thread ID format (UUID)
    const safeThreadId = sanitizeUuid(threadId);

    const client = new Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.timeoutMs,
    });

    try {
      await client.connect();

      const threadResult = await client.query(
        `SELECT 
          id,
          status,
          name,
          current_branch_name as "currentBranchName",
          repo_base_branch_name as "repoBaseBranchName",
          github_pr_number as "githubPrNumber",
          github_repo_full_name as "githubRepoFullName",
          sandbox_provider as "sandboxProvider",
          codesandbox_id as "codesandboxId",
          created_at as "createdAt",
          updated_at as "updatedAt"
         FROM thread
         WHERE id = $1`,
        [safeThreadId],
      );

      if (threadResult.rows.length === 0) {
        throw new Error(`No thread found with id ${safeThreadId}`);
      }

      const data = threadResult.rows[0] as DatabaseThreadState;

      return {
        name: "database",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data,
      };
    } finally {
      await client.end();
    }
  }

  async fetchEventJournal(
    workflowId: string,
    limit: number = 50,
  ): Promise<SourceSnapshot<DatabaseEventJournal>> {
    const startTime = Date.now();

    // Validate workflow ID format (UUID)
    const safeWorkflowId = sanitizeUuid(workflowId);

    const client = new Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.timeoutMs,
    });

    try {
      await client.connect();

      const eventsResult = await client.query(
        `SELECT 
          id,
          event_type as "eventType",
          occurred_at as "occurredAt",
          idempotency_key as "idempotencyKey"
         FROM delivery_loop_journal_v3
         WHERE workflow_id = $1
         ORDER BY occurred_at DESC
         LIMIT $2`,
        [safeWorkflowId, limit],
      );

      // Get max version from effects ledger as proxy for "latest version"
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(workflow_version), 0) as "maxVersion"
         FROM delivery_effect_ledger_v3
         WHERE workflow_id = $1`,
        [safeWorkflowId],
      );

      const data: DatabaseEventJournal = {
        events: eventsResult.rows,
        maxVersion: versionResult.rows[0]?.maxVersion || 0,
      };

      return {
        name: "database",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data,
      };
    } finally {
      await client.end();
    }
  }

  async fetchSignalInbox(workflowId: string): Promise<SourceSnapshot> {
    const startTime = Date.now();

    // Validate workflow ID format (UUID)
    const safeWorkflowId = sanitizeUuid(workflowId);

    const client = new Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.timeoutMs,
    });

    try {
      await client.connect();

      // Check which signal inbox table exists (using parameterized query for safety)
      const tableCheck = await client.query(
        `SELECT to_regclass('public.delivery_signal_inbox') as exists`,
      );

      const tableName = tableCheck.rows[0]?.exists
        ? "delivery_signal_inbox"
        : "sdlc_loop_signal_inbox";

      const signalsResult = await client.query(
        `SELECT 
          id,
          cause_type as "causeType",
          processed_at as "processedAt",
          dead_lettered_at as "deadLetteredAt",
          processing_attempt_count as "processingAttemptCount",
          claimed_at as "claimedAt",
          received_at as "receivedAt"
         FROM ${tableName}
         WHERE loop_id = $1
         ORDER BY received_at DESC
         LIMIT 20`,
        [safeWorkflowId],
      );

      return {
        name: "database",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: {
          tableName,
          signals: signalsResult.rows,
          unprocessedCount: signalsResult.rows.filter(
            (s: { processedAt: null }) => !s.processedAt,
          ).length,
        },
      };
    } finally {
      await client.end();
    }
  }

  async fetchAll(threadId: string): Promise<{
    workflow: SourceSnapshot<DatabaseWorkflowState>;
    thread: SourceSnapshot<DatabaseThreadState>;
    journal?: SourceSnapshot<DatabaseEventJournal>;
    signals?: SourceSnapshot;
  }> {
    const workflow = await this.fetchWorkflowState(threadId);
    const thread = await this.fetchThreadState(threadId);

    // Deep mode: fetch journal and signals only if workflow data exists
    let journal: SourceSnapshot<DatabaseEventJournal> | undefined;
    let signals: SourceSnapshot | undefined;

    if (workflow.data) {
      journal = await this.fetchEventJournal(workflow.data.workflowId);
      signals = await this.fetchSignalInbox(workflow.data.workflowId);
    }

    return {
      workflow,
      thread,
      journal,
      signals,
    };
  }
}

export function createDatabaseFetcher(
  connectionString?: string,
): DatabaseSourceFetcher {
  const connStr = connectionString || process.env.DATABASE_URL;

  if (!connStr) {
    throw new Error(
      "DATABASE_URL environment variable is required. " +
        "Set it to your PostgreSQL connection string.",
    );
  }

  return new DatabaseSourceFetcher({
    connectionString: connStr,
    timeoutMs: 10000,
  });
}
