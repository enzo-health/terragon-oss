ALTER TABLE "sdlc_loop" ALTER COLUMN "pr_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ALTER COLUMN "state" SET DEFAULT 'planning';--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "fix_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "max_fix_attempts" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "plan_approval_policy" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "active_plan_artifact_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "active_implementation_artifact_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "active_review_artifact_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "active_ui_artifact_id" text;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD COLUMN "active_babysit_artifact_id" text;--> statement-breakpoint
DROP INDEX IF EXISTS "sdlc_loop_user_repo_pr_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "sdlc_loop_repo_pr_index";--> statement-breakpoint
CREATE INDEX "sdlc_loop_repo_pr_state_index" ON "sdlc_loop" USING btree ("repo_full_name","pr_number","state");--> statement-breakpoint
CREATE INDEX "sdlc_loop_user_repo_pr_state_index" ON "sdlc_loop" USING btree ("user_id","repo_full_name","pr_number","state");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sdlc_phase_artifact" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" text NOT NULL,
	"phase" text NOT NULL,
	"artifact_type" text NOT NULL,
	"head_sha" text,
	"loop_version" integer NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"generated_by" text DEFAULT 'system' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "sdlc_phase_artifact" ADD CONSTRAINT "sdlc_phase_artifact_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_phase_artifact" ADD CONSTRAINT "sdlc_phase_artifact_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sdlc_phase_artifact_loop_phase_created_index" ON "sdlc_phase_artifact" USING btree ("loop_id","phase","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_phase_artifact_loop_phase_status_created_index" ON "sdlc_phase_artifact" USING btree ("loop_id","phase","status","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_phase_artifact_loop_head_phase_created_index" ON "sdlc_phase_artifact" USING btree ("loop_id","head_sha","phase","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sdlc_plan_task" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"stable_task_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"completed_at" timestamp,
	"completed_by" text,
	"completion_evidence" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "sdlc_plan_task" ADD CONSTRAINT "sdlc_plan_task_artifact_id_sdlc_phase_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."sdlc_phase_artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_plan_task" ADD CONSTRAINT "sdlc_plan_task_loop_id_sdlc_loop_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sdlc_loop"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_plan_task_artifact_stable_task_unique" ON "sdlc_plan_task" USING btree ("artifact_id","stable_task_id");--> statement-breakpoint
CREATE INDEX "sdlc_plan_task_loop_status_index" ON "sdlc_plan_task" USING btree ("loop_id","status");--> statement-breakpoint
CREATE INDEX "sdlc_plan_task_loop_artifact_status_index" ON "sdlc_plan_task" USING btree ("loop_id","artifact_id","status");--> statement-breakpoint

ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_active_plan_artifact_id_sdlc_phase_artifact_id_fk" FOREIGN KEY ("active_plan_artifact_id") REFERENCES "public"."sdlc_phase_artifact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_active_implementation_artifact_id_sdlc_phase_artifact_id_fk" FOREIGN KEY ("active_implementation_artifact_id") REFERENCES "public"."sdlc_phase_artifact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_active_review_artifact_id_sdlc_phase_artifact_id_fk" FOREIGN KEY ("active_review_artifact_id") REFERENCES "public"."sdlc_phase_artifact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_active_ui_artifact_id_sdlc_phase_artifact_id_fk" FOREIGN KEY ("active_ui_artifact_id") REFERENCES "public"."sdlc_phase_artifact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_active_babysit_artifact_id_sdlc_phase_artifact_id_fk" FOREIGN KEY ("active_babysit_artifact_id") REFERENCES "public"."sdlc_phase_artifact"("id") ON DELETE set null ON UPDATE no action;
