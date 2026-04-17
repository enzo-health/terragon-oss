-- Add last_resurrected_at column to delivery_workflow_head_v3.
-- Tracks the timestamp of the most recent workflow_resurrected transition so
-- the reducer can enforce a per-workflow cooldown. Without this, a user with
-- PR write access could trigger a wake-storm by posting many comments in
-- quick succession, each resetting the agent's retry budgets and dispatching
-- a new run (see PR #145 security review).
--
-- Nullable with no default — existing rows default to NULL which is
-- semantically identical to "never resurrected", so the first resurrection
-- always fires on backfill.

ALTER TABLE "delivery_workflow_head_v3"
  ADD COLUMN IF NOT EXISTS "last_resurrected_at" timestamp;
