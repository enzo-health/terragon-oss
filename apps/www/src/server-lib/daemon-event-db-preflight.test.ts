import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@terragon/shared/db";

const AGENT_RUN_CONTEXT_COLUMNS = [
  "failure_category",
  "failure_source",
  "failure_retryable",
  "failure_signature_hash",
  "failure_terminal_reason",
] as const;

const TOKEN_STREAM_EVENT_COLUMNS = [
  "id",
  "stream_seq",
  "user_id",
  "run_id",
  "thread_id",
  "thread_chat_id",
  "thread_chat_message_seq",
  "message_id",
  "part_index",
  "part_type",
  "text",
  "idempotency_key",
  "created_at",
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
    { rows: [{ exists: "token_stream_event" }] },
    { rows: [{ exists: "agent_event_log" }] },
    {
      rows: AGENT_RUN_CONTEXT_COLUMNS.map((column_name) => ({ column_name })),
    },
    {
      rows: TOKEN_STREAM_EVENT_COLUMNS.map((column_name) => ({ column_name })),
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
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    const db = { execute } as unknown as DB;
    const { getDaemonEventDbPreflight } = await import(
      "./daemon-event-db-preflight"
    );

    const first = await getDaemonEventDbPreflight(db);
    expect(first).toMatchObject({
      agentEventLogReady: false,
      tokenStreamEventReady: false,
      agentRunContextFailureColumnsReady: false,
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const second = await getDaemonEventDbPreflight(db);
    expect(second.agentEventLogReady).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);

    for (const response of createReadySchemaResponses()) {
      execute.mockResolvedValueOnce(response);
    }

    vi.setSystemTime(new Date("2026-04-19T00:00:06.000Z"));

    const third = await getDaemonEventDbPreflight(db);
    expect(third).toMatchObject({
      agentEventLogReady: true,
      tokenStreamEventReady: true,
      agentRunContextFailureColumnsReady: true,
    });
    expect(execute).toHaveBeenCalledTimes(6);
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
      tokenStreamEventReady: false,
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
      tokenStreamEventReady: true,
      agentRunContextFailureColumnsReady: true,
    });
    expect(execute).toHaveBeenCalledTimes(6);
  });
});
