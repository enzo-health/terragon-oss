-- Drop dead tables removed during the 2026-05 architecture cleanup.
-- These tables had no active code consumers and were identified as
-- orphaned during the Phase 1 dead-code sweep.

DROP TABLE IF EXISTS "waitlist";
--> statement-breakpoint
DROP TABLE IF EXISTS "onboarding_questionnaire";
--> statement-breakpoint
DROP TABLE IF EXISTS "claude_oauth_tokens";
--> statement-breakpoint
DROP TABLE IF EXISTS "gemini_auth";
--> statement-breakpoint
DROP TABLE IF EXISTS "amp_auth";
--> statement-breakpoint
DROP TABLE IF EXISTS "openai_auth";
--> statement-breakpoint
DROP TABLE IF EXISTS "feedback";
--> statement-breakpoint
DROP TABLE IF EXISTS "reengagement_emails";
--> statement-breakpoint
DROP TABLE IF EXISTS "onboarding_completion_emails";
