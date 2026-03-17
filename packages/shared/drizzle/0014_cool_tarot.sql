CREATE TABLE IF NOT EXISTS "delivery_loop_incident" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"incident_type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detail" text,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_loop_runtime_status" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"gate" text,
	"pending_action_kind" text,
	"health" text DEFAULT 'healthy' NOT NULL,
	"last_signal_at" timestamp,
	"last_transition_at" timestamp,
	"last_dispatch_at" timestamp,
	"oldest_unprocessed_signal_age_ms" integer,
	"fix_attempt_count" integer,
	"open_incident_count" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_work_item" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"scheduled_at" timestamp DEFAULT now() NOT NULL,
	"claimed_at" timestamp,
	"claim_token" text,
	"payload_json" jsonb NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_workflow" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"generation" integer NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"state_json" jsonb NOT NULL,
	"fix_attempt_count" integer DEFAULT 0 NOT NULL,
	"max_fix_attempts" integer DEFAULT 6 NOT NULL,
	"sdlc_loop_id" text,
	"repo_full_name" text DEFAULT '' NOT NULL,
	"pr_number" integer,
	"user_id" text DEFAULT '' NOT NULL,
	"plan_approval_policy" text DEFAULT 'auto' NOT NULL,
	"current_head_sha" text,
	"blocked_reason" text,
	"head_sha" text,
	"review_surface_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_workflow_event" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"seq" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"state_before" text NOT NULL,
	"state_after" text,
	"gate_before" text,
	"gate_after" text,
	"payload_json" jsonb,
	"signal_id" text,
	"trigger_source" text NOT NULL,
	"head_sha" text,
	"previous_phase_duration_ms" integer,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" DROP CONSTRAINT IF EXISTS "sdlc_loop_signal_inbox_loop_id_sdlc_loop_id_fk";
--> statement-breakpoint
ALTER TABLE "sdlc_ci_gate_run" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "processing_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "last_processing_error" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "dead_letter_reason" text;--> statement-breakpoint
ALTER TABLE "sdlc_phase_artifact" ADD COLUMN IF NOT EXISTS "workflow_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_review_thread_gate_run" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "delivery_loop_incident" DROP CONSTRAINT IF EXISTS "delivery_loop_incident_workflow_id_delivery_workflow_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_loop_incident" ADD CONSTRAINT "delivery_loop_incident_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_loop_runtime_status" DROP CONSTRAINT IF EXISTS "delivery_loop_runtime_status_workflow_id_delivery_workflow_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_loop_runtime_status" ADD CONSTRAINT "delivery_loop_runtime_status_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_work_item" DROP CONSTRAINT IF EXISTS "delivery_work_item_workflow_id_delivery_workflow_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_work_item" ADD CONSTRAINT "delivery_work_item_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflow" DROP CONSTRAINT IF EXISTS "delivery_workflow_thread_id_thread_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD CONSTRAINT "delivery_workflow_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflow" DROP CONSTRAINT IF EXISTS "delivery_workflow_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD CONSTRAINT "delivery_workflow_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflow_event" DROP CONSTRAINT IF EXISTS "delivery_workflow_event_workflow_id_delivery_workflow_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_workflow_event" ADD CONSTRAINT "delivery_workflow_event_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_loop_incident_workflow_status_index" ON "delivery_loop_incident" USING btree ("workflow_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_work_item_workflow_status_index" ON "delivery_work_item" USING btree ("workflow_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_work_item_claimable_index" ON "delivery_work_item" USING btree ("status","scheduled_at") WHERE "delivery_work_item"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_work_item_correlation_index" ON "delivery_work_item" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_workflow_thread_generation_unique" ON "delivery_workflow" USING btree ("thread_id","generation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_workflow_kind_index" ON "delivery_workflow" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_workflow_thread_id_index" ON "delivery_workflow" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_workflow_user_id_index" ON "delivery_workflow" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_workflow_event_seq_unique" ON "delivery_workflow_event" USING btree ("workflow_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_workflow_event_occurred_index" ON "delivery_workflow_event" USING btree ("workflow_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_workflow_event_correlation_index" ON "delivery_workflow_event" USING btree ("correlation_id");--> statement-breakpoint
ALTER TABLE "sdlc_phase_artifact" DROP CONSTRAINT IF EXISTS "sdlc_phase_artifact_workflow_id_delivery_workflow_id_fk";--> statement-breakpoint
ALTER TABLE "sdlc_phase_artifact" ADD CONSTRAINT "sdlc_phase_artifact_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sdlc_ci_gate_run_idempotency_key_unique" ON "sdlc_ci_gate_run" USING btree ("idempotency_key") WHERE "sdlc_ci_gate_run"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sdlc_loop_signal_inbox_claimable_unclaimed_index" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","received_at") WHERE "sdlc_loop_signal_inbox"."processed_at" is null and "sdlc_loop_signal_inbox"."claim_token" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sdlc_loop_signal_inbox_claimable_stale_index" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","claimed_at","received_at") WHERE "sdlc_loop_signal_inbox"."processed_at" is null and "sdlc_loop_signal_inbox"."claim_token" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sdlc_phase_artifact_workflow_id_index" ON "sdlc_phase_artifact" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sdlc_review_thread_gate_run_idempotency_key_unique" ON "sdlc_review_thread_gate_run" USING btree ("idempotency_key") WHERE "sdlc_review_thread_gate_run"."idempotency_key" is not null;
