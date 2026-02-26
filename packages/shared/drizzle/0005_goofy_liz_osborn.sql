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
ALTER TABLE "preview_validation_attempt" ADD CONSTRAINT "preview_validation_attempt_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_validation_attempt" ADD CONSTRAINT "preview_validation_attempt_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_validation_attempt" ADD CONSTRAINT "preview_validation_attempt_run_id_thread_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_validation_attempt_run_id_index" ON "preview_validation_attempt" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "preview_validation_attempt_thread_created_at_index" ON "preview_validation_attempt" USING btree ("thread_id","created_at");