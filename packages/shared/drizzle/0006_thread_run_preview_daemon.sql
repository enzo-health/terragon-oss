CREATE TABLE "daemon_event_quarantine" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"run_id_or_null" text,
	"active_run_id" text,
	"reason" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_prefix_2k" text NOT NULL,
	"payload_r2_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_session" (
	"preview_session_id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text,
	"codesandbox_id" text NOT NULL,
	"sandbox_provider" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"preview_command" text,
	"preview_port" integer,
	"preview_health_path" text,
	"preview_requires_websocket" boolean DEFAULT false NOT NULL,
	"preview_open_mode" text DEFAULT 'iframe' NOT NULL,
	"upstream_origin" text,
	"upstream_origin_token" text,
	"provider_auth_headers_json" jsonb,
	"pinned_upstream_ips_json" jsonb,
	"revocation_version" integer DEFAULT 1 NOT NULL,
	"last_dns_check_at" timestamp,
	"dns_refreshed_once" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"unsupported_reason" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_validation_attempt" (
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"command" text,
	"exit_code" integer,
	"duration_ms" integer,
	"diff_source" text DEFAULT 'sha' NOT NULL,
	"diff_source_context_json" jsonb,
	"matched_ui_rules_json" jsonb,
	"capability_snapshot_json" jsonb,
	"summary_r2_key" text,
	"summary_sha256" text,
	"summary_bytes" integer,
	"stdout_r2_key" text,
	"stdout_sha256" text,
	"stdout_bytes" integer,
	"stderr_r2_key" text,
	"stderr_sha256" text,
	"stderr_bytes" integer,
	"trace_r2_key" text,
	"trace_sha256" text,
	"trace_bytes" integer,
	"screenshot_r2_key" text,
	"screenshot_sha256" text,
	"screenshot_bytes" integer,
	"video_r2_key" text,
	"video_sha256" text,
	"video_bytes" integer,
	"video_unsupported_reason" text,
	"timeout_code" text,
	"timeout_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "preview_validation_attempt_thread_run_attempt_pk" PRIMARY KEY("thread_id","run_id","attempt_number")
);
--> statement-breakpoint
CREATE TABLE "thread_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"start_request_id" text NOT NULL,
	"trigger_source" text NOT NULL,
	"status" text DEFAULT 'booting' NOT NULL,
	"codesandbox_id" text,
	"sandbox_provider" text,
	"run_start_sha" text,
	"run_end_sha" text,
	"frozen_flag_snapshot_json" jsonb NOT NULL,
	"terminal_event_id" text,
	"last_accepted_seq" integer,
	"daemon_payload_version" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_run_context" (
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"active_run_id" text NOT NULL,
	"active_codesandbox_id" text,
	"active_sandbox_provider" text,
	"active_status" text DEFAULT 'booting' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"active_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_run_context_thread_chat_pk" PRIMARY KEY("thread_id","thread_chat_id")
);
--> statement-breakpoint
CREATE TABLE "thread_ui_validation" (
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"latest_run_id" text,
	"ui_validation_outcome" text DEFAULT 'not_required' NOT NULL,
	"ready_downgrade_state" text DEFAULT 'not_attempted' NOT NULL,
	"ready_downgrade_last_attempt_at" timestamp,
	"blocking_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_ui_validation_thread_chat_pk" PRIMARY KEY("thread_id","thread_chat_id")
);
--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN "committed_at" timestamp;--> statement-breakpoint
ALTER TABLE "daemon_event_quarantine" ADD CONSTRAINT "daemon_event_quarantine_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_event_quarantine" ADD CONSTRAINT "daemon_event_quarantine_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_run_id_thread_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_validation_attempt" ADD CONSTRAINT "preview_validation_attempt_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_validation_attempt" ADD CONSTRAINT "preview_validation_attempt_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_validation_attempt" ADD CONSTRAINT "preview_validation_attempt_run_id_thread_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run" ADD CONSTRAINT "thread_run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run" ADD CONSTRAINT "thread_run_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_context" ADD CONSTRAINT "thread_run_context_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_context" ADD CONSTRAINT "thread_run_context_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_context" ADD CONSTRAINT "thread_run_context_active_run_id_thread_run_run_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_ui_validation" ADD CONSTRAINT "thread_ui_validation_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_ui_validation" ADD CONSTRAINT "thread_ui_validation_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_ui_validation" ADD CONSTRAINT "thread_ui_validation_latest_run_id_thread_run_run_id_fk" FOREIGN KEY ("latest_run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daemon_event_quarantine_thread_created_at_index" ON "daemon_event_quarantine" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "preview_session_run_created_at_index" ON "preview_session" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "preview_session_thread_created_at_index" ON "preview_session" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "preview_session_state_index" ON "preview_session" USING btree ("state");--> statement-breakpoint
CREATE INDEX "preview_validation_attempt_run_id_index" ON "preview_validation_attempt" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "preview_validation_attempt_thread_created_at_index" ON "preview_validation_attempt" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_run_thread_chat_start_request_unique" ON "thread_run" USING btree ("thread_id","thread_chat_id","start_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_run_active_thread_chat_unique" ON "thread_run" USING btree ("thread_id","thread_chat_id") WHERE "thread_run"."status" in ('booting', 'running', 'validating');--> statement-breakpoint
CREATE INDEX "thread_run_thread_chat_created_at_index" ON "thread_run" USING btree ("thread_id","thread_chat_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_run_status_index" ON "thread_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "thread_run_terminal_event_id_index" ON "thread_run" USING btree ("terminal_event_id");--> statement-breakpoint
CREATE INDEX "thread_run_context_active_run_id_index" ON "thread_run_context" USING btree ("active_run_id");--> statement-breakpoint
CREATE INDEX "thread_ui_validation_latest_run_id_index" ON "thread_ui_validation" USING btree ("latest_run_id");