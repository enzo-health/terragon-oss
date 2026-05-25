ALTER TABLE "linear_installation"
  ADD COLUMN IF NOT EXISTS "app_user_id" text;
--> statement-breakpoint
