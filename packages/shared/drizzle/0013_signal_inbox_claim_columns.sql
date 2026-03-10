ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp;
