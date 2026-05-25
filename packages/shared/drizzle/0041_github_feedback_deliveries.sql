CREATE TABLE IF NOT EXISTS "github_feedback_deliveries" (
	"delivery_marker_key" text PRIMARY KEY NOT NULL,
	"thread_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
