CREATE TABLE "github_surface_binding" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"surface_kind" text NOT NULL,
	"surface_github_id" text NOT NULL,
	"surface_metadata" jsonb,
	"lane" text NOT NULL,
	"routing_reason" text NOT NULL,
	"bound_head_sha" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_surface_binding" ADD CONSTRAINT "github_surface_binding_workspace_id_github_pr_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."github_pr_workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "github_surface_binding_surface_kind_surface_github_id_unique" ON "github_surface_binding" USING btree ("surface_kind","surface_github_id");
--> statement-breakpoint
CREATE INDEX "github_surface_binding_workspace_id_index" ON "github_surface_binding" USING btree ("workspace_id");
