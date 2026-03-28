-- Idempotent prod drift guardrails for token streaming + run context metadata.

-- Ensure delivery loop failure metadata columns exist on agent_run_context.
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "failure_category" text;

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "failure_source" text;

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "failure_retryable" boolean;

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "failure_signature_hash" integer;

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "failure_terminal_reason" text;

-- Ensure token_stream_event table exists (for durable token replay).
CREATE TABLE IF NOT EXISTS "token_stream_event" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stream_seq" bigserial NOT NULL,
  "user_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "thread_chat_id" text NOT NULL,
  "message_id" text NOT NULL,
  "part_index" integer NOT NULL,
  "part_type" text DEFAULT 'text' NOT NULL,
  "text" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'token_stream_event_user_id_user_id_fk'
  ) THEN
    ALTER TABLE "token_stream_event"
      ADD CONSTRAINT "token_stream_event_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'token_stream_event_thread_id_thread_id_fk'
  ) THEN
    ALTER TABLE "token_stream_event"
      ADD CONSTRAINT "token_stream_event_thread_id_thread_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "token_stream_event_stream_seq_unique"
  ON "token_stream_event" USING btree ("stream_seq");

CREATE UNIQUE INDEX IF NOT EXISTS "token_stream_event_idempotency_key_unique"
  ON "token_stream_event" USING btree ("idempotency_key");

CREATE INDEX IF NOT EXISTS "token_stream_event_thread_part_seq_idx"
  ON "token_stream_event" USING btree ("thread_chat_id", "message_id", "part_index", "stream_seq");

CREATE INDEX IF NOT EXISTS "token_stream_event_replay_idx"
  ON "token_stream_event" USING btree ("user_id", "thread_id", "thread_chat_id", "stream_seq");
