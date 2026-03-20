CREATE TABLE "delivery_effect_ledger_v3" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version" integer NOT NULL,
	"effect_kind" text NOT NULL,
	"effect_key" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"payload_json" jsonb NOT NULL,
	"due_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp,
	"claimed_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_loop_journal_v3" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_workflow_head_v3" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"active_gate" text,
	"head_sha" text,
	"active_run_id" text,
	"fix_attempt_count" integer DEFAULT 0 NOT NULL,
	"infra_retry_count" integer DEFAULT 0 NOT NULL,
	"max_fix_attempts" integer DEFAULT 6 NOT NULL,
	"max_infra_retries" integer DEFAULT 10 NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "delivery_workflow_retrospective" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"outcome" text NOT NULL,
	"e2e_duration_ms" integer NOT NULL,
	"phase_metrics" jsonb NOT NULL,
	"gate_metrics" jsonb NOT NULL,
	"failure_patterns" jsonb NOT NULL,
	"retry_metrics" jsonb NOT NULL,
	"dispatch_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_workflow_retrospective_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD COLUMN "infra_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_effect_ledger_v3" ADD CONSTRAINT "delivery_effect_ledger_v3_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_loop_journal_v3" ADD CONSTRAINT "delivery_loop_journal_v3_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflow_head_v3" ADD CONSTRAINT "delivery_workflow_head_v3_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflow_head_v3" ADD CONSTRAINT "delivery_workflow_head_v3_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflow_retrospective" ADD CONSTRAINT "delivery_workflow_retrospective_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_effect_ledger_v3_effect_key_unique" ON "delivery_effect_ledger_v3" USING btree ("effect_key");--> statement-breakpoint
CREATE INDEX "delivery_effect_ledger_v3_claimable_index" ON "delivery_effect_ledger_v3" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "delivery_effect_ledger_v3_workflow_index" ON "delivery_effect_ledger_v3" USING btree ("workflow_id","workflow_version");--> statement-breakpoint
CREATE INDEX "delivery_effect_ledger_v3_lease_expiry_index" ON "delivery_effect_ledger_v3" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_loop_journal_v3_dedupe_unique" ON "delivery_loop_journal_v3" USING btree ("workflow_id","source","idempotency_key");--> statement-breakpoint
CREATE INDEX "delivery_loop_journal_v3_workflow_created_index" ON "delivery_loop_journal_v3" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_workflow_head_v3_state_index" ON "delivery_workflow_head_v3" USING btree ("state");--> statement-breakpoint
CREATE INDEX "delivery_workflow_head_v3_thread_index" ON "delivery_workflow_head_v3" USING btree ("thread_id");