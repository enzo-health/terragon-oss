CREATE TABLE "sdlc_loop" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"thread_id" text NOT NULL,
	"state" text DEFAULT 'enrolled' NOT NULL,
	"current_head_sha" text,
	"loop_version" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sdlc_loop" ADD CONSTRAINT "sdlc_loop_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_user_repo_pr_unique" ON "sdlc_loop" USING btree ("user_id","repo_full_name","pr_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_thread_unique" ON "sdlc_loop" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX "sdlc_loop_repo_pr_index" ON "sdlc_loop" USING btree ("repo_full_name","pr_number");
--> statement-breakpoint
CREATE INDEX "sdlc_loop_user_index" ON "sdlc_loop" USING btree ("user_id");
