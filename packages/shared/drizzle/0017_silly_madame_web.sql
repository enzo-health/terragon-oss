CREATE TABLE "delivery_outbox_v3" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"topic" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp,
	"claimed_at" timestamp,
	"published_at" timestamp,
	"relay_message_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_timer_ledger_v3" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"timer_kind" text NOT NULL,
	"timer_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_signal_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"payload_json" jsonb NOT NULL,
	"due_at" timestamp NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp,
	"claimed_at" timestamp,
	"fired_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "delivery_effect_ledger_v3_effect_key_unique";--> statement-breakpoint
DROP INDEX "delivery_effect_ledger_v3_claimable_index";--> statement-breakpoint
ALTER TABLE "delivery_effect_ledger_v3" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_outbox_v3" ADD CONSTRAINT "delivery_outbox_v3_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_timer_ledger_v3" ADD CONSTRAINT "delivery_timer_ledger_v3_workflow_id_delivery_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."delivery_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_timer_ledger_v3" ADD CONSTRAINT "delivery_timer_ledger_v3_source_signal_id_delivery_loop_journal_v3_id_fk" FOREIGN KEY ("source_signal_id") REFERENCES "public"."delivery_loop_journal_v3"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_outbox_v3_dedupe_key_unique" ON "delivery_outbox_v3" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_outbox_v3_topic_idempotency_unique" ON "delivery_outbox_v3" USING btree ("workflow_id","topic","idempotency_key");--> statement-breakpoint
CREATE INDEX "delivery_outbox_v3_claimable_index" ON "delivery_outbox_v3" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_v3_lease_expiry_index" ON "delivery_outbox_v3" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_v3_workflow_status_index" ON "delivery_outbox_v3" USING btree ("workflow_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_timer_ledger_v3_dedupe_unique" ON "delivery_timer_ledger_v3" USING btree ("workflow_id","timer_kind","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_timer_ledger_v3_timer_key_unique" ON "delivery_timer_ledger_v3" USING btree ("workflow_id","timer_key");--> statement-breakpoint
CREATE INDEX "delivery_timer_ledger_v3_claimable_index" ON "delivery_timer_ledger_v3" USING btree ("status","due_at","created_at");--> statement-breakpoint
CREATE INDEX "delivery_timer_ledger_v3_lease_expiry_index" ON "delivery_timer_ledger_v3" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "delivery_timer_ledger_v3_workflow_status_index" ON "delivery_timer_ledger_v3" USING btree ("workflow_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_effect_ledger_v3_effect_dedupe_unique" ON "delivery_effect_ledger_v3" USING btree ("workflow_id","effect_kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "delivery_effect_ledger_v3_claimable_index" ON "delivery_effect_ledger_v3" USING btree ("status","due_at","created_at");