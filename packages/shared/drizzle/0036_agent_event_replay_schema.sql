-- Add the canonical event log table and reconcile token replay columns with
-- the current schema. Older dev databases may have token_stream_event without
-- run_id/thread_chat_message_seq and no agent_event_log table at all.

CREATE TABLE IF NOT EXISTS "agent_event_log" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "log_seq" bigserial NOT NULL,
  "event_id" text NOT NULL,
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "thread_chat_id" text NOT NULL,
  "seq" bigint NOT NULL,
  "event_type" text NOT NULL,
  "category" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "timestamp" timestamp NOT NULL,
  "thread_chat_message_seq" integer,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_event_log_thread_id_thread_id_fk'
  ) THEN
    ALTER TABLE "agent_event_log"
      ADD CONSTRAINT "agent_event_log_thread_id_thread_id_fk"
      FOREIGN KEY ("thread_id")
      REFERENCES "public"."thread"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_event_log_log_seq_unique"
  ON "agent_event_log" USING btree ("log_seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_event_log_run_event_unique"
  ON "agent_event_log" USING btree ("run_id", "event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_event_log_run_seq_unique"
  ON "agent_event_log" USING btree ("run_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_log_run_seq_idx"
  ON "agent_event_log" USING btree ("run_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_log_thread_log_seq_idx"
  ON "agent_event_log" USING btree ("thread_id", "log_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_log_thread_chat_log_seq_idx"
  ON "agent_event_log" USING btree ("thread_chat_id", "log_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_log_thread_replay_seq_idx"
  ON "agent_event_log" USING btree ("thread_id", "thread_chat_message_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_log_thread_chat_replay_seq_idx"
  ON "agent_event_log" USING btree ("thread_chat_id", "thread_chat_message_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_log_timestamp_idx"
  ON "agent_event_log" USING btree ("timestamp");
--> statement-breakpoint
ALTER TABLE "token_stream_event"
  ADD COLUMN IF NOT EXISTS "run_id" text;
--> statement-breakpoint
ALTER TABLE "token_stream_event"
  ADD COLUMN IF NOT EXISTS "thread_chat_message_seq" integer;
--> statement-breakpoint
UPDATE "token_stream_event"
SET "run_id" = ''
WHERE "run_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "token_stream_event"
  ALTER COLUMN "run_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "token_stream_event_thread_part_seq_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_stream_event_thread_part_seq_idx"
  ON "token_stream_event" USING btree (
    "thread_chat_id",
    "thread_chat_message_seq",
    "message_id",
    "part_index",
    "stream_seq"
  );
--> statement-breakpoint
DROP INDEX IF EXISTS "token_stream_event_replay_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_stream_event_replay_idx"
  ON "token_stream_event" USING btree (
    "user_id",
    "run_id",
    "thread_id",
    "thread_chat_id",
    "thread_chat_message_seq",
    "stream_seq"
  );
