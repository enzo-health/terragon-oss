CREATE TABLE "delivery_loop_dispatch_intent" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"run_id" text NOT NULL,
	"target_phase" text NOT NULL,
	"selected_agent" text NOT NULL,
	"execution_class" text NOT NULL,
	"dispatch_mechanism" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failure_category" text,
	"failure_message" text,
	"dispatched_at" timestamp,
	"acknowledged_at" timestamp,
	"completed_at" timestamp,
	"failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_loop_dispatch_intent" ADD CONSTRAINT "delivery_loop_dispatch_intent_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_loop_dispatch_intent" ADD CONSTRAINT "delivery_loop_dispatch_intent_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_loop_dispatch_intent_run_id_unique" ON "delivery_loop_dispatch_intent" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "delivery_loop_dispatch_intent_loop_status_index" ON "delivery_loop_dispatch_intent" USING btree ("loop_id","status");--> statement-breakpoint
CREATE INDEX "delivery_loop_dispatch_intent_thread_chat_index" ON "delivery_loop_dispatch_intent" USING btree ("thread_chat_id");