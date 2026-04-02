-- Add run-sequence lease fields to the v3 workflow head contract.

ALTER TABLE "delivery_workflow_head_v3"
  ADD COLUMN IF NOT EXISTS "active_run_seq" bigint;

ALTER TABLE "delivery_workflow_head_v3"
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp;

ALTER TABLE "delivery_workflow_head_v3"
  ADD COLUMN IF NOT EXISTS "last_terminal_run_seq" bigint;
