ALTER TABLE "thread" ADD COLUMN "message_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_chat" ADD COLUMN "message_seq" integer DEFAULT 0 NOT NULL;