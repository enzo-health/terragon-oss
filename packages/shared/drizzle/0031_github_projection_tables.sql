CREATE TABLE "github_installation_projection" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"target_account_id" bigint,
	"target_account_login" text,
	"target_account_type" text,
	"permissions_json" jsonb,
	"is_suspended" boolean DEFAULT false NOT NULL,
	"suspended_at" timestamp,
	"last_webhook_received_at" timestamp,
	"last_webhook_succeeded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repo_projection" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_projection_id" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"repo_node_id" text,
	"current_slug" text NOT NULL,
	"default_branch" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"has_read_access" boolean DEFAULT false NOT NULL,
	"has_write_access" boolean DEFAULT false NOT NULL,
	"has_admin_access" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_pr_projection" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_projection_id" text NOT NULL,
	"pr_node_id" text NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"base_ref" text,
	"head_ref" text,
	"head_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_repo_projection" ADD CONSTRAINT "github_repo_projection_installation_projection_id_github_installation_projection_id_fk" FOREIGN KEY ("installation_projection_id") REFERENCES "public"."github_installation_projection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pr_projection" ADD CONSTRAINT "github_pr_projection_repo_projection_id_github_repo_projection_id_fk" FOREIGN KEY ("repo_projection_id") REFERENCES "public"."github_repo_projection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_projection_installation_id_unique" ON "github_installation_projection" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_projection_repo_id_unique" ON "github_repo_projection" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "github_repo_projection_installation_projection_id_index" ON "github_repo_projection" USING btree ("installation_projection_id");--> statement-breakpoint
CREATE INDEX "github_repo_projection_current_slug_index" ON "github_repo_projection" USING btree ("current_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "github_pr_projection_pr_node_id_unique" ON "github_pr_projection" USING btree ("pr_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_pr_projection_repo_projection_number_unique" ON "github_pr_projection" USING btree ("repo_projection_id","number");
