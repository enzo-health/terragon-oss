DROP TABLE IF EXISTS "sdlc_loop_outbox_attempt";
--> statement-breakpoint
DROP TABLE IF EXISTS "sdlc_loop_outbox";
--> statement-breakpoint
DROP TABLE IF EXISTS "sdlc_loop_lease";
--> statement-breakpoint
DROP TABLE IF EXISTS "sdlc_loop" CASCADE;
--> statement-breakpoint
ALTER TABLE "delivery_workflow" DROP COLUMN IF EXISTS "sdlc_loop_id";
--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD COLUMN "canonical_status_comment_id" text;
--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD COLUMN "canonical_status_comment_node_id" text;
--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD COLUMN "canonical_status_comment_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD COLUMN "canonical_check_run_id" bigint;
--> statement-breakpoint
ALTER TABLE "delivery_workflow" ADD COLUMN "canonical_check_run_updated_at" timestamp with time zone;
