ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sdlc_loop_signal_inbox_claimable_unclaimed_index" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","received_at") WHERE ("processed_at" IS NULL AND "claim_token" IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sdlc_loop_signal_inbox_claimable_stale_index" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","claimed_at","received_at") WHERE ("processed_at" IS NULL AND "claim_token" IS NOT NULL);
