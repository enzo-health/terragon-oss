ALTER TABLE "agent_run_context"
ADD COLUMN IF NOT EXISTS "failure_category" text;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
ADD COLUMN IF NOT EXISTS "failure_message" text;
