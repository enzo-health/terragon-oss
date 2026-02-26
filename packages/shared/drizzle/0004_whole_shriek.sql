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
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_thread_chat_id_thread_chat_id_fk" FOREIGN KEY ("thread_chat_id") REFERENCES "public"."thread_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_run_id_thread_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."thread_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_session" ADD CONSTRAINT "preview_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_session_run_created_at_index" ON "preview_session" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "preview_session_thread_created_at_index" ON "preview_session" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "preview_session_state_index" ON "preview_session" USING btree ("state");