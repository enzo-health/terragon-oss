/**
 * Database Source Fetcher
 *
 * Direct PostgreSQL queries for ground truth.
 * Uses the same connection logic as delivery-loop-local-framework.ts
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

export class DatabaseSourceFetcher {
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async fetchWorkflowState(
    threadId: string,
  ): Promise<SourceSnapshot<DatabaseWorkflowState>> {
    const startTime = Date.now();
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
        [threadId],
      );

      if (workflowResult.rows.length === 0) {
        throw new Error(`No workflow found for thread ${threadId}`);
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
        [threadId],
      );

      if (threadResult.rows.length === 0) {
        throw new Error(`No thread found with id ${threadId}`);
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
        [workflowId, limit],
      );

      // Get max version from effects ledger as proxy for "latest version"
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(workflow_version), 0) as "maxVersion"
         FROM delivery_effect_ledger_v3
         WHERE workflow_id = $1`,
        [workflowId],
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
    const client = new Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.timeoutMs,
    });

    try {
      await client.connect();

      // Check which signal inbox table exists
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
        [workflowId],
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

    // Deep mode: fetch journal and signals
    const journal = await this.fetchEventJournal(workflow.data.workflowId);
    const signals = await this.fetchSignalInbox(workflow.data.workflowId);

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
  const connStr =
    connectionString ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/postgres";

  return new DatabaseSourceFetcher({
    connectionString: connStr,
    timeoutMs: 10000,
  });
}
