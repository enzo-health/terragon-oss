import { sql } from "drizzle-orm";
import type { DB } from "@terragon/shared/db";

const REQUIRED_AGENT_RUN_CONTEXT_COLUMNS = [
  "failure_category",
  "failure_source",
  "failure_retryable",
  "failure_signature_hash",
  "failure_terminal_reason",
] as const;

const REQUIRED_AGENT_EVENT_LOG_COLUMNS = [
  "id",
  "log_seq",
  "event_id",
  "run_id",
  "thread_id",
  "thread_chat_id",
  "thread_chat_message_seq",
  "seq",
  "event_type",
  "category",
  "payload_json",
  "idempotency_key",
  "timestamp",
  "created_at",
] as const;

type DaemonEventDbPreflight = {
  agentEventLogReady: boolean;
  agentRunContextFailureColumnsReady: boolean;
  missing: string[];
};

const PREFLIGHT_SUCCESS_TTL_MS = 60_000;
const PREFLIGHT_RETRY_TTL_MS = 5_000;

let preflightPromise: Promise<DaemonEventDbPreflight> | null = null;
let preflightExpiresAt = 0;

function isPreflightFullyReady(result: DaemonEventDbPreflight): boolean {
  return result.agentEventLogReady && result.agentRunContextFailureColumnsReady;
}

function missingFromRequired({
  required,
  found,
  table,
}: {
  required: readonly string[];
  found: Set<string>;
  table: string;
}): string[] {
  const missing: string[] = [];
  for (const column of required) {
    if (!found.has(column)) {
      missing.push(`${table}.${column}`);
    }
  }
  return missing;
}

export async function getDaemonEventDbPreflight(
  db: DB,
): Promise<DaemonEventDbPreflight> {
  if (!preflightPromise || Date.now() >= preflightExpiresAt) {
    preflightPromise = runDaemonEventDbPreflight(db).then((result) => {
      preflightExpiresAt =
        Date.now() +
        (isPreflightFullyReady(result)
          ? PREFLIGHT_SUCCESS_TTL_MS
          : PREFLIGHT_RETRY_TTL_MS);
      return result;
    });
  }
  return preflightPromise;
}

async function runDaemonEventDbPreflight(
  db: DB,
): Promise<DaemonEventDbPreflight> {
  try {
    const agentEventLogTableResult = await db.execute<{
      exists: string | null;
    }>(sql`SELECT to_regclass('public.agent_event_log') as exists`);
    const agentEventLogTableExists =
      agentEventLogTableResult.rows[0]?.exists === "agent_event_log";

    const arcColumnsResult = await db.execute<{ column_name: string }>(
      sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_run_context'
      `,
    );
    const arcColumns = new Set(
      arcColumnsResult.rows.map((row) => row.column_name),
    );
    if (!arcColumnsResult.rows.length) {
      return {
        agentEventLogReady: false,
        agentRunContextFailureColumnsReady: false,
        missing: [],
      };
    }

    const agentEventLogColumnsResult = agentEventLogTableExists
      ? await db.execute<{ column_name: string }>(
          sql`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'agent_event_log'
          `,
        )
      : { rows: [] as Array<{ column_name: string }> };
    const agentEventLogColumns = new Set(
      agentEventLogColumnsResult.rows.map((row) => row.column_name),
    );

    const missing: string[] = [];
    missing.push(
      ...missingFromRequired({
        required: REQUIRED_AGENT_RUN_CONTEXT_COLUMNS,
        found: arcColumns,
        table: "agent_run_context",
      }),
    );

    if (!agentEventLogTableExists) {
      missing.push("agent_event_log");
    } else {
      missing.push(
        ...missingFromRequired({
          required: REQUIRED_AGENT_EVENT_LOG_COLUMNS,
          found: agentEventLogColumns,
          table: "agent_event_log",
        }),
      );
    }

    if (missing.length > 0) {
      console.error("[daemon-event] db preflight missing schema objects", {
        missing,
      });
    }

    return {
      agentEventLogReady:
        agentEventLogTableExists &&
        missingFromRequired({
          required: REQUIRED_AGENT_EVENT_LOG_COLUMNS,
          found: agentEventLogColumns,
          table: "agent_event_log",
        }).length === 0,
      agentRunContextFailureColumnsReady:
        missingFromRequired({
          required: REQUIRED_AGENT_RUN_CONTEXT_COLUMNS,
          found: arcColumns,
          table: "agent_run_context",
        }).length === 0,
      missing,
    };
  } catch (error) {
    console.error("[daemon-event] db preflight failed", { error });
    return {
      agentEventLogReady: false,
      agentRunContextFailureColumnsReady: false,
      missing: ["preflight_query_failed"],
    };
  }
}
