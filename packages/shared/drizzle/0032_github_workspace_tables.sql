ALTER TABLE "delivery_workflow" ADD CONSTRAINT "delivery_workflow_id_thread_id_unique" UNIQUE("id","thread_id");
--> statement-breakpoint
ALTER TABLE "github_pr_projection" ADD CONSTRAINT "github_pr_projection_id_repo_id_unique" UNIQUE("id","repo_id");
--> statement-breakpoint
CREATE TABLE "github_pr_workspace" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_projection_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_projection_id" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"pr_projection_id" text NOT NULL,
	"pr_node_id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"head_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_workspace_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"lane" text NOT NULL,
	"head_sha" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"thread_id" text NOT NULL,
	"workflow_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_workspace_run_attempt_positive" CHECK ("attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "github_pr_workspace" ADD CONSTRAINT "github_pr_workspace_installation_projection_id_installation_id_fk" FOREIGN KEY ("installation_projection_id","installation_id") REFERENCES "public"."github_installation_projection"("id","installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pr_workspace" ADD CONSTRAINT "github_pr_workspace_repo_projection_id_repo_id_fk" FOREIGN KEY ("repo_projection_id","repo_id") REFERENCES "public"."github_repo_projection"("id","repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pr_workspace" ADD CONSTRAINT "github_pr_workspace_pr_projection_id_repo_id_fk" FOREIGN KEY ("pr_projection_id","repo_id") REFERENCES "public"."github_pr_projection"("id","repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_workspace_run" ADD CONSTRAINT "github_workspace_run_workspace_id_github_pr_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."github_pr_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_workspace_run" ADD CONSTRAINT "github_workspace_run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_workspace_run" ADD CONSTRAINT "github_workspace_run_workflow_id_thread_id_fk" FOREIGN KEY ("workflow_id","thread_id") REFERENCES "public"."delivery_workflow"("id","thread_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_pr_workspace_pr_projection_id_unique" ON "github_pr_workspace" USING btree ("pr_projection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_pr_workspace_installation_repo_pr_node_id_unique" ON "github_pr_workspace" USING btree ("installation_id","repo_id","pr_node_id");--> statement-breakpoint
CREATE INDEX "github_pr_workspace_installation_projection_id_index" ON "github_pr_workspace" USING btree ("installation_projection_id");--> statement-breakpoint
CREATE INDEX "github_pr_workspace_repo_projection_id_index" ON "github_pr_workspace" USING btree ("repo_projection_id");--> statement-breakpoint
CREATE INDEX "github_pr_workspace_pr_projection_id_index" ON "github_pr_workspace" USING btree ("pr_projection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_workspace_run_workspace_lane_head_sha_attempt_unique" ON "github_workspace_run" USING btree ("workspace_id","lane","head_sha","attempt");--> statement-breakpoint
CREATE INDEX "github_workspace_run_workspace_id_index" ON "github_workspace_run" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_workspace_run_thread_id_index" ON "github_workspace_run" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "github_workspace_run_workflow_id_index" ON "github_workspace_run" USING btree ("workflow_id");
