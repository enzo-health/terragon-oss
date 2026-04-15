-- Add narration_only_retry_count column to delivery_workflow_head_v3.
-- Tracks consecutive retries where the agent completed without invoking any
-- tool calls (narrate-only loop). After NO_PROGRESS_RETRY_THRESHOLD (3)
-- consecutive narration-only completions, the reducer escalates the workflow
-- to awaiting_manual_fix instead of dispatching another retry.
--
-- Existing rows default to 0 — semantically identical to "no narrate-only
-- streak observed yet", which is the correct rollover behavior.

ALTER TABLE "delivery_workflow_head_v3"
  ADD COLUMN IF NOT EXISTS "narration_only_retry_count" integer DEFAULT 0 NOT NULL;
