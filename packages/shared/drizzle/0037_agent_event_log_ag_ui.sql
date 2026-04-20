-- Migration 0037: agent_event_log carries AG-UI BaseEvent payloads.
--
-- Purpose:
--   Repurpose agent_event_log.payload_json to hold AG-UI protocol BaseEvent
--   values directly. First-class columns (event_id, run_id, seq, thread_id,
--   thread_chat_id, timestamp, category, event_type) are unchanged.
--
-- Schema changes:
--   1. Drop UNIQUE(run_id, seq) and replace with UNIQUE(thread_chat_id, seq).
--      `seq` becomes a per-thread-chat monotonic counter; UNIQUE(run_id,
--      event_id) remains the idempotency key.
--   2. Drop the `token_stream_event` table. Streaming deltas now flow through
--      agent_event_log as AG-UI TEXT_MESSAGE_CONTENT / REASONING_MESSAGE_CONTENT
--      events.
--
-- Apply atomically with the Task 2C writer cutover commit. This migration
-- cannot be applied to a DB without the corresponding writer update without
-- causing seq-collision failures on subsequent runs.

CREATE UNIQUE INDEX IF NOT EXISTS "agent_event_log_thread_chat_seq_unique"
  ON "agent_event_log" USING btree ("thread_chat_id", "seq");
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_event_log_run_seq_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "token_stream_event_stream_seq_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "token_stream_event_idempotency_key_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "token_stream_event_thread_part_seq_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "token_stream_event_replay_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "token_stream_event";
