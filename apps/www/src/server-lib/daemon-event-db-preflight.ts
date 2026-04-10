import { sql } from "drizzle-orm";
import type { DB } from "@leo/shared/db";

const REQUIRED_AGENT_RUN_CONTEXT_COLUMNS = [
  "failure_category",
  "failure_source",
  "failure_retryable",
  "failure_signature_hash",
  "failure_terminal_reason",
] as const;

const REQUIRED_TOKEN_STREAM_EVENT_COLUMNS = [
  "id",
  "stream_seq",
  "user_id",
  "thread_id",
  "thread_chat_id",
  "message_id",
  "part_index",
  "part_type",
  "text",
  "idempotency_key",
  "created_at",
] as const;

type DaemonEventDbPreflight = {
  tokenStreamEventReady: boolean;
  agentRunContextFailureColumnsReady: boolean;
  missing: string[];
};

let preflightPromise: Promise<DaemonEventDbPreflight> | null = null;

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
  if (!preflightPromise) {
    preflightPromise = runDaemonEventDbPreflight(db);
  }
  return preflightPromise;
}

async function runDaemonEventDbPreflight(
  db: DB,
): Promise<DaemonEventDbPreflight> {
  try {
    const tokenTableResult = await db.execute<{ exists: string | null }>(
      sql`SELECT to_regclass('public.token_stream_event') as exists`,
    );
    if (!tokenTableResult.rows.length) {
      return {
        tokenStreamEventReady: true,
        agentRunContextFailureColumnsReady: true,
        missing: [],
      };
    }
    const tokenTableExists =
      tokenTableResult.rows[0]?.exists === "token_stream_event";

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
        tokenStreamEventReady: true,
        agentRunContextFailureColumnsReady: true,
        missing: [],
      };
    }

    const tokenColumnsResult = tokenTableExists
      ? await db.execute<{ column_name: string }>(
          sql`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'token_stream_event'
          `,
        )
      : { rows: [] as Array<{ column_name: string }> };
    const tokenColumns = new Set(
      tokenColumnsResult.rows.map((row) => row.column_name),
    );

    const missing: string[] = [];
    missing.push(
      ...missingFromRequired({
        required: REQUIRED_AGENT_RUN_CONTEXT_COLUMNS,
        found: arcColumns,
        table: "agent_run_context",
      }),
    );

    if (!tokenTableExists) {
      missing.push("token_stream_event");
    } else {
      missing.push(
        ...missingFromRequired({
          required: REQUIRED_TOKEN_STREAM_EVENT_COLUMNS,
          found: tokenColumns,
          table: "token_stream_event",
        }),
      );
    }

    if (missing.length > 0) {
      console.error("[daemon-event] db preflight missing schema objects", {
        missing,
      });
    }

    return {
      tokenStreamEventReady:
        tokenTableExists &&
        missingFromRequired({
          required: REQUIRED_TOKEN_STREAM_EVENT_COLUMNS,
          found: tokenColumns,
          table: "token_stream_event",
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
      tokenStreamEventReady: true,
      agentRunContextFailureColumnsReady: true,
      missing: ["preflight_query_failed"],
    };
  }
}
