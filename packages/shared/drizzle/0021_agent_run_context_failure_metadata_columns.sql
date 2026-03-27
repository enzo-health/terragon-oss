ALTER TABLE "agent_run_context"
ADD COLUMN IF NOT EXISTS "failure_source" text;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
ADD COLUMN IF NOT EXISTS "failure_retryable" boolean;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
ADD COLUMN IF NOT EXISTS "failure_signature_hash" integer;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
ADD COLUMN IF NOT EXISTS "failure_terminal_reason" text;
