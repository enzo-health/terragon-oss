ALTER TABLE "linear_settings"
ADD COLUMN "delivery_loop_opt_in" boolean DEFAULT false NOT NULL,
ADD COLUMN "delivery_plan_approval_policy" text;
