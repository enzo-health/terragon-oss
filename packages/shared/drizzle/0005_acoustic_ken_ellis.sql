CREATE TABLE "sdlc_carmack_review_finding" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_run_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"stable_finding_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"detail" text NOT NULL,
	"suggested_fix" text,
	"is_blocking" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_event_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_carmack_review_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"loop_version" integer NOT NULL,
	"status" text DEFAULT 'invalid_output' NOT NULL,
	"gate_passed" boolean DEFAULT false NOT NULL,
	"invalid_output" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"raw_output" jsonb,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_ci_gate_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"loop_version" integer NOT NULL,
	"status" text NOT NULL,
	"gate_passed" boolean DEFAULT false NOT NULL,
	"actor_type" text DEFAULT 'installation_app' NOT NULL,
	"capability_state" text NOT NULL,
	"required_check_source" text NOT NULL,
	"required_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failing_required_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb,
	"normalization_version" integer DEFAULT 1 NOT NULL,
	"trigger_event_type" text NOT NULL,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_deep_review_finding" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_run_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"stable_finding_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"detail" text NOT NULL,
	"suggested_fix" text,
	"is_blocking" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_event_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_deep_review_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"loop_version" integer NOT NULL,
	"status" text DEFAULT 'invalid_output' NOT NULL,
	"gate_passed" boolean DEFAULT false NOT NULL,
	"invalid_output" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"raw_output" jsonb,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_loop_outbox_attempt" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"action_type" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"error_class" text,
	"error_code" text,
	"error_message" text,
	"retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_parity_metric_sample" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cause_type" text NOT NULL,
	"target_class" text NOT NULL,
	"eligible" boolean DEFAULT true NOT NULL,
	"matched" boolean NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_review_thread_gate_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"loop_version" integer NOT NULL,
	"status" text NOT NULL,
	"gate_passed" boolean DEFAULT false NOT NULL,
	"evaluation_source" text NOT NULL,
	"unresolved_thread_count" integer DEFAULT 0 NOT NULL,
	"timeout_ms" integer,
	"trigger_event_type" text NOT NULL,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "sdlc_loop_user_repo_pr_unique";--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "canonical_status_comment_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "canonical_status_comment_node_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "canonical_status_comment_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "canonical_check_run_id" bigint;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "canonical_check_run_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "video_capture_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_artifact_r2_key" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_artifact_mime_type" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_artifact_bytes" integer;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_captured_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_failure_class" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_failure_code" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_failure_message" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "latest_video_failed_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox" ADD COLUMN "next_retry_at" timestamp;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox" ADD COLUMN "last_error_class" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox" ADD COLUMN "last_error_message" text;--> statement-breakpoint
ALTER TABLE "sdlc_carmack_review_finding" ADD CONSTRAINT "sdlc_carmack_review_finding_review_run_id_sdlc_carmack_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."sdlc_carmack_review_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_carmack_review_finding" ADD CONSTRAINT "sdlc_carmack_review_finding_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_carmack_review_run" ADD CONSTRAINT "sdlc_carmack_review_run_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_ci_gate_run" ADD CONSTRAINT "sdlc_ci_gate_run_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_deep_review_finding" ADD CONSTRAINT "sdlc_deep_review_finding_review_run_id_sdlc_deep_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."sdlc_deep_review_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_deep_review_finding" ADD CONSTRAINT "sdlc_deep_review_finding_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_deep_review_run" ADD CONSTRAINT "sdlc_deep_review_run_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox_attempt" ADD CONSTRAINT "sdlc_loop_outbox_attempt_outbox_id_sdlc_loop_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."sdlc_loop_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox_attempt" ADD CONSTRAINT "sdlc_loop_outbox_attempt_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_review_thread_gate_run" ADD CONSTRAINT "sdlc_review_thread_gate_run_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_carmack_review_finding_loop_head_stable_unique" ON "sdlc_carmack_review_finding" USING btree ("loop_id","head_sha","stable_finding_id");--> statement-breakpoint
CREATE INDEX "sdlc_carmack_review_finding_loop_head_blocking_index" ON "sdlc_carmack_review_finding" USING btree ("loop_id","head_sha","is_blocking","resolved_at");--> statement-breakpoint
CREATE INDEX "sdlc_carmack_review_finding_run_id_index" ON "sdlc_carmack_review_finding" USING btree ("review_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_carmack_review_run_loop_head_unique" ON "sdlc_carmack_review_run" USING btree ("loop_id","head_sha");--> statement-breakpoint
CREATE INDEX "sdlc_carmack_review_run_loop_created_index" ON "sdlc_carmack_review_run" USING btree ("loop_id","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_carmack_review_run_status_index" ON "sdlc_carmack_review_run" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_ci_gate_run_loop_head_unique" ON "sdlc_ci_gate_run" USING btree ("loop_id","head_sha");--> statement-breakpoint
CREATE INDEX "sdlc_ci_gate_run_loop_created_index" ON "sdlc_ci_gate_run" USING btree ("loop_id","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_ci_gate_run_status_index" ON "sdlc_ci_gate_run" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_deep_review_finding_loop_head_stable_unique" ON "sdlc_deep_review_finding" USING btree ("loop_id","head_sha","stable_finding_id");--> statement-breakpoint
CREATE INDEX "sdlc_deep_review_finding_loop_head_blocking_index" ON "sdlc_deep_review_finding" USING btree ("loop_id","head_sha","is_blocking","resolved_at");--> statement-breakpoint
CREATE INDEX "sdlc_deep_review_finding_run_id_index" ON "sdlc_deep_review_finding" USING btree ("review_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_deep_review_run_loop_head_unique" ON "sdlc_deep_review_run" USING btree ("loop_id","head_sha");--> statement-breakpoint
CREATE INDEX "sdlc_deep_review_run_loop_created_index" ON "sdlc_deep_review_run" USING btree ("loop_id","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_deep_review_run_status_index" ON "sdlc_deep_review_run" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_outbox_attempt_outbox_attempt_unique" ON "sdlc_loop_outbox_attempt" USING btree ("outbox_id","attempt");--> statement-breakpoint
CREATE INDEX "sdlc_loop_outbox_attempt_loop_created_index" ON "sdlc_loop_outbox_attempt" USING btree ("loop_id","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_loop_outbox_attempt_status_retry_index" ON "sdlc_loop_outbox_attempt" USING btree ("status","retry_at");--> statement-breakpoint
CREATE INDEX "sdlc_parity_metric_sample_bucket_index" ON "sdlc_parity_metric_sample" USING btree ("cause_type","target_class","observed_at");--> statement-breakpoint
CREATE INDEX "sdlc_parity_metric_sample_observed_index" ON "sdlc_parity_metric_sample" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "sdlc_parity_metric_sample_eligible_index" ON "sdlc_parity_metric_sample" USING btree ("eligible","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_review_thread_gate_run_loop_head_unique" ON "sdlc_review_thread_gate_run" USING btree ("loop_id","head_sha");--> statement-breakpoint
CREATE INDEX "sdlc_review_thread_gate_run_loop_created_index" ON "sdlc_review_thread_gate_run" USING btree ("loop_id","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_review_thread_gate_run_status_index" ON "sdlc_review_thread_gate_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sdlc_loop_outbox_loop_status_retry_index" ON "sdlc_loop_outbox" USING btree ("loop_id","status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_user_repo_pr_unique" ON "sdlc_loop" USING btree ("user_id","repo_full_name","pr_number") WHERE "sdlc_loop"."state" in (
        'enrolled',
        'implementing',
        'gates_running',
        'blocked_on_agent_fixes',
        'blocked_on_ci',
        'blocked_on_review_threads',
        'video_pending',
        'human_review_ready',
        'video_degraded_ready',
        'blocked_on_human_feedback'
      );