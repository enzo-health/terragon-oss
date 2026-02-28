CREATE TABLE "agent_run_context" (
	"run_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"thread_chat_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"transport_mode" text DEFAULT 'legacy' NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"agent" text NOT NULL,
	"permission_mode" text DEFAULT 'allowAll' NOT NULL,
	"requested_session_id" text,
	"resolved_session_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_nonce" text NOT NULL,
	"daemon_token_key_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_context" ADD CONSTRAINT "agent_run_context_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_run_context" ADD CONSTRAINT "agent_run_context_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_run_context_thread_chat_id_idx" ON "agent_run_context" USING btree ("thread_id","thread_chat_id");
--> statement-breakpoint
CREATE INDEX "agent_run_context_sandbox_id_idx" ON "agent_run_context" USING btree ("sandbox_id");
--> statement-breakpoint
CREATE INDEX "agent_run_context_status_idx" ON "agent_run_context" USING btree ("status");
