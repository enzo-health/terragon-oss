CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"claimant_token" text NOT NULL,
	"claim_expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"event_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_loop_lease" (
	"loop_id" text PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_loop_outbox" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"transition_seq" bigint NOT NULL,
	"action_type" text NOT NULL,
	"supersession_group" text NOT NULL,
	"action_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"superseded_by_outbox_id" text,
	"canceled_reason" text,
	"claimed_by" text,
	"claimed_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdlc_loop_signal_inbox" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"cause_type" text NOT NULL,
	"canonical_cause_id" text NOT NULL,
	"signal_head_sha_or_null" text,
	"cause_identity_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "sdlc_loop_lease" ADD CONSTRAINT "sdlc_loop_lease_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop_outbox" ADD CONSTRAINT "sdlc_loop_outbox_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD CONSTRAINT "sdlc_loop_signal_inbox_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sdlc_loop_lease_owner_expires_index" ON "sdlc_loop_lease" USING btree ("lease_owner","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_outbox_loop_action_key_unique" ON "sdlc_loop_outbox" USING btree ("loop_id","action_key");--> statement-breakpoint
CREATE INDEX "sdlc_loop_outbox_loop_status_transition_index" ON "sdlc_loop_outbox" USING btree ("loop_id","status","transition_seq");--> statement-breakpoint
CREATE INDEX "sdlc_loop_outbox_loop_group_transition_index" ON "sdlc_loop_outbox" USING btree ("loop_id","supersession_group","transition_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_signal_inbox_dedupe_unique" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","cause_type","canonical_cause_id","signal_head_sha_or_null","cause_identity_version");--> statement-breakpoint
CREATE INDEX "sdlc_loop_signal_inbox_loop_received_index" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","received_at");