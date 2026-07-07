ALTER TABLE "slack_account" DROP CONSTRAINT IF EXISTS "slack_account_slack_user_id_unique";

CREATE TABLE IF NOT EXISTS "slack_task_deliveries" (
  "delivery_key" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL,
  "channel" text NOT NULL,
  "message_ts" text NOT NULL,
  "slack_event_id" text,
  "action" text DEFAULT 'create' NOT NULL,
  "status" text DEFAULT 'claimed' NOT NULL,
  "claimant_token" text,
  "claim_expires_at" timestamp,
  "claimed_at" timestamp,
  "completed_at" timestamp,
  "thread_id" text,
  "thread_chat_id" text,
  "slack_thread_link_id" text,
  "ignored_reason" text,
  "omitted_reason" text,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "slack_thread_links" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "thread_chat_id" text,
  "team_id" text NOT NULL,
  "enterprise_id" text,
  "is_enterprise_install" boolean DEFAULT false NOT NULL,
  "channel_team_id" text,
  "source_team_id" text,
  "workspace_domain" text NOT NULL,
  "channel" text NOT NULL,
  "root_message_ts" text NOT NULL,
  "thread_ts" text NOT NULL,
  "origin" text NOT NULL,
  "mirror_mode" text DEFAULT 'status-and-final' NOT NULL,
  "collaboration_mode" text DEFAULT 'same-team-linked-users' NOT NULL,
  "muted_at" timestamp,
  "last_inbound_message_ts" text,
  "status_message_ts" text,
  "created_by_slack_user_id" text NOT NULL,
  "last_actor_slack_user_id" text,
  "sleeping_at" timestamp,
  "sleep_until" timestamp,
  "archived_at" timestamp,
  "unlinked_at" timestamp,
  "slack_context_json" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "slack_outbound_deliveries" (
  "delivery_key" text PRIMARY KEY NOT NULL,
  "slack_thread_link_id" text,
  "thread_id" text NOT NULL,
  "thread_chat_id" text,
  "team_id" text NOT NULL,
  "channel" text NOT NULL,
  "thread_ts" text NOT NULL,
  "message_ts" text,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "payload_hash" text,
  "claimant_token" text,
  "claim_expires_at" timestamp,
  "claimed_at" timestamp,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp,
  "last_error" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "slack_thread_links"
    ADD CONSTRAINT "slack_thread_links_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "slack_thread_links"
    ADD CONSTRAINT "slack_thread_links_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "slack_outbound_deliveries"
    ADD CONSTRAINT "slack_outbound_deliveries_slack_thread_link_id_fk"
    FOREIGN KEY ("slack_thread_link_id") REFERENCES "public"."slack_thread_links"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "slack_thread_links_thread_id" ON "slack_thread_links" ("thread_id");
CREATE INDEX IF NOT EXISTS "slack_thread_links_team_channel_thread" ON "slack_thread_links" ("team_id", "channel", "thread_ts");
CREATE INDEX IF NOT EXISTS "slack_thread_links_user_team" ON "slack_thread_links" ("user_id", "team_id");
CREATE UNIQUE INDEX IF NOT EXISTS "slack_thread_links_active_unique"
  ON "slack_thread_links" ("team_id", "channel", "thread_ts")
  WHERE "archived_at" IS NULL AND "unlinked_at" IS NULL;
