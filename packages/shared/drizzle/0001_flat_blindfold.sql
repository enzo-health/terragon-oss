CREATE TABLE "linear_account" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"linear_user_id" text NOT NULL,
	"linear_user_name" text NOT NULL,
	"linear_user_email" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_installation" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"organization_name" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp,
	"scope" text NOT NULL,
	"installer_user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "linear_installation_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "linear_settings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"default_repo_full_name" text,
	"default_model" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp,
	"thread_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_account" ADD CONSTRAINT "linear_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_installation" ADD CONSTRAINT "linear_installation_installer_user_id_user_id_fk" FOREIGN KEY ("installer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_settings" ADD CONSTRAINT "linear_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_account_user_org_unique" ON "linear_account" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_account_linear_user_org_unique" ON "linear_account" USING btree ("linear_user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_settings_user_org_unique" ON "linear_settings" USING btree ("user_id","organization_id");