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
ALTER TABLE "thread_run" ADD COLUMN "daemon_payload_version" integer;--> statement-breakpoint
ALTER TABLE "daemon_event_quarantine" ADD CONSTRAINT "daemon_event_quarantine_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_event_quarantine" ADD CONSTRAINT "daemon_event_quarantine_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daemon_event_quarantine_thread_created_at_index" ON "daemon_event_quarantine" USING btree ("thread_id","created_at");