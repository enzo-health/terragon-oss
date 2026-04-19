-- Drop legacy user settings columns that are no longer read by the app.

ALTER TABLE "onboarding_questionnaire"
  DROP COLUMN IF EXISTS "primary_use";
--> statement-breakpoint
ALTER TABLE "onboarding_questionnaire"
  DROP COLUMN IF EXISTS "feedback_willingness";
--> statement-breakpoint
ALTER TABLE "onboarding_questionnaire"
  DROP COLUMN IF EXISTS "interview_willingness";
--> statement-breakpoint
ALTER TABLE "user_settings"
  DROP COLUMN IF EXISTS "auto_push_branches";
--> statement-breakpoint
ALTER TABLE "user_flags"
  DROP COLUMN IF EXISTS "last_seen_release_notes";
