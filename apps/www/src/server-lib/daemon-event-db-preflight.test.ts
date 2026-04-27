import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@terragon/shared/db";

const AGENT_RUN_CONTEXT_COLUMNS = [
  "run_id",
  "thread_id",
  "thread_chat_id",
  "transport_mode",
  "protocol_version",
  "requested_session_id",
  "resolved_session_id",
  "runtime_provider",
  "external_session_id",
  "previous_response_id",
  "checkpoint_pointer",
  "hibernation_valid",
  "compaction_generation",
  "last_accepted_seq",
  "terminal_event_id",
  "status",
  "daemon_token_key_id",
  "failure_category",
  "failure_source",
  "failure_retryable",
  "failure_signature_hash",
  "failure_terminal_reason",
] as const;

const AGENT_EVENT_LOG_COLUMNS = [
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

function createReadySchemaResponses() {
  return [
    { rows: [{ exists: "agent_event_log" }] },
    {
      rows: AGENT_RUN_CONTEXT_COLUMNS.map((column_name) => ({ column_name })),
    },
    {
      rows: AGENT_EVENT_LOG_COLUMNS.map((column_name) => ({ column_name })),
    },
  ];
}

describe("getDaemonEventDbPreflight", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries non-ready results after the retry ttl instead of caching them forever", async () => {
    const execute = vi
      .fn()
      // First call: agent_event_log table lookup returns "no table"
      .mockResolvedValueOnce({ rows: [{ exists: null }] })
      // arc columns — empty to trigger early non-ready return
      .mockResolvedValueOnce({ rows: [] });
    const db = { execute } as unknown as DB;
    const { getDaemonEventDbPreflight } = await import(
      "./daemon-event-db-preflight"
    );

    const first = await getDaemonEventDbPreflight(db);
    expect(first).toMatchObject({
      agentEventLogReady: false,
      agentRunContextFailureColumnsReady: false,
    });

    const firstCalls = execute.mock.calls.length;

    const second = await getDaemonEventDbPreflight(db);
    expect(second.agentEventLogReady).toBe(false);
    expect(execute).toHaveBeenCalledTimes(firstCalls);

    for (const response of createReadySchemaResponses()) {
      execute.mockResolvedValueOnce(response);
    }

    vi.setSystemTime(new Date("2026-04-19T00:00:06.000Z"));

    const third = await getDaemonEventDbPreflight(db);
    expect(third).toMatchObject({
      agentEventLogReady: true,
      agentRunContextFailureColumnsReady: true,
    });
  });

  it("retries query failures after the retry ttl instead of caching preflight_query_failed forever", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata offline"));
    const db = { execute } as unknown as DB;
    const { getDaemonEventDbPreflight } = await import(
      "./daemon-event-db-preflight"
    );

    const first = await getDaemonEventDbPreflight(db);
    expect(first).toMatchObject({
      agentEventLogReady: false,
      agentRunContextFailureColumnsReady: false,
      missing: ["preflight_query_failed"],
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const second = await getDaemonEventDbPreflight(db);
    expect(second.missing).toEqual(["preflight_query_failed"]);
    expect(execute).toHaveBeenCalledTimes(1);

    for (const response of createReadySchemaResponses()) {
      execute.mockResolvedValueOnce(response);
    }

    vi.setSystemTime(new Date("2026-04-19T00:00:06.000Z"));

    const third = await getDaemonEventDbPreflight(db);
    expect(third).toMatchObject({
      agentEventLogReady: true,
      agentRunContextFailureColumnsReady: true,
    });
  });
});
