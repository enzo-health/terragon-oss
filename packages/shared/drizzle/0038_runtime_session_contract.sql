-- Add runtime-session ownership fields to the AgentRun aggregate.
-- These are nullable during the rewrite so existing runs and legacy session
-- shims can coexist while new adapters move ownership into agent_run_context.
--
-- Pre-drop boundary for delivery-loop removal:
--   - runtime/session resume metadata lives on agent_run_context, not on
--     delivery-loop projections
--   - replay cursors are accepted only from daemon/canonical event fences;
--     agent_event_log seq is an AG-UI replay cursor in a different domain
--   - delivery-loop tables are intentionally left intact in this migration

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "runtime_provider" text;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "external_session_id" text;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "previous_response_id" text;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "checkpoint_pointer" text;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "hibernation_valid" boolean;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "compaction_generation" integer;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "last_accepted_seq" bigint;
--> statement-breakpoint
ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "terminal_event_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_context_thread_chat_updated_at_idx"
  ON "agent_run_context" USING btree (
    "thread_id",
    "thread_chat_id",
    "updated_at"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_context_runtime_session_idx"
  ON "agent_run_context" USING btree (
    "runtime_provider",
    "external_session_id"
  );
--> statement-breakpoint
UPDATE "agent_run_context" arc
SET
  "runtime_provider" = COALESCE(
    arc."runtime_provider",
    CASE
      WHEN arc."transport_mode" = 'codex-app-server' THEN 'codex-app-server'
      WHEN arc."transport_mode" = 'acp' THEN 'claude-acp'
      WHEN arc."agent" = 'claudeCode' THEN 'legacy-claude'
      WHEN arc."agent" = 'gemini' THEN 'legacy-gemini'
      WHEN arc."agent" = 'amp' THEN 'legacy-amp'
      WHEN arc."agent" = 'opencode' THEN 'legacy-opencode'
      ELSE NULL
    END
  ),
  "external_session_id" = COALESCE(
    arc."external_session_id",
    NULLIF(tc."session_id", '')
  ),
  "resolved_session_id" = COALESCE(
    arc."resolved_session_id",
    NULLIF(tc."session_id", '')
  ),
  "previous_response_id" = COALESCE(
    arc."previous_response_id",
    NULLIF(tc."codex_previous_response_id", '')
  )
FROM "thread_chat" tc
WHERE arc."thread_chat_id" = tc."id"
  AND arc."thread_id" = tc."thread_id";
--> statement-breakpoint
