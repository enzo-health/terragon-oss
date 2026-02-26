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
ALTER TABLE "thread_run" ADD CONSTRAINT "thread_run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run" ADD CONSTRAINT "thread_run_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_context" ADD CONSTRAINT "thread_run_context_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_context" ADD CONSTRAINT "thread_run_context_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_context" ADD CONSTRAINT "thread_run_context_active_run_id_thread_run_run_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_ui_validation" ADD CONSTRAINT "thread_ui_validation_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_ui_validation" ADD CONSTRAINT "thread_ui_validation_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_ui_validation" ADD CONSTRAINT "thread_ui_validation_latest_run_id_thread_run_run_id_fk" FOREIGN KEY ("latest_run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_run_thread_chat_start_request_unique" ON "thread_run" USING btree ("thread_id","thread_chat_id","start_request_id");--> statement-breakpoint
CREATE INDEX "thread_run_thread_chat_created_at_index" ON "thread_run" USING btree ("thread_id","thread_chat_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_run_status_index" ON "thread_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "thread_run_terminal_event_id_index" ON "thread_run" USING btree ("terminal_event_id");--> statement-breakpoint
CREATE INDEX "thread_run_context_active_run_id_index" ON "thread_run_context" USING btree ("active_run_id");--> statement-breakpoint
CREATE INDEX "thread_ui_validation_latest_run_id_index" ON "thread_ui_validation" USING btree ("latest_run_id");
