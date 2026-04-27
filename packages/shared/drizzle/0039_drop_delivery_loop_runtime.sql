DROP INDEX IF EXISTS "agent_run_context_workflow_run_seq_idx";
ALTER TABLE "agent_run_context" DROP CONSTRAINT IF EXISTS "agent_run_context_workflow_id_delivery_workflow_id_fk";
ALTER TABLE "agent_run_context" DROP COLUMN IF EXISTS "workflow_id";
ALTER TABLE "agent_run_context" DROP COLUMN IF EXISTS "run_seq";

DROP INDEX IF EXISTS "github_workspace_run_workflow_id_index";
ALTER TABLE "github_workspace_run" DROP CONSTRAINT IF EXISTS "github_workspace_run_workflow_id_thread_id_fk";
ALTER TABLE "github_workspace_run" DROP COLUMN IF EXISTS "workflow_id";

ALTER TABLE "linear_settings" DROP COLUMN IF EXISTS "delivery_loop_opt_in";
ALTER TABLE "linear_settings" DROP COLUMN IF EXISTS "delivery_plan_approval_policy";

DROP TABLE IF EXISTS "delivery_plan_task";
DROP TABLE IF EXISTS "delivery_phase_artifact";
DROP TABLE IF EXISTS "delivery_signal_inbox";
DROP TABLE IF EXISTS "delivery_deep_review_finding";
DROP TABLE IF EXISTS "delivery_deep_review_run";
DROP TABLE IF EXISTS "delivery_carmack_review_finding";
DROP TABLE IF EXISTS "delivery_carmack_review_run";
DROP TABLE IF EXISTS "delivery_ci_gate_run";
DROP TABLE IF EXISTS "delivery_review_thread_gate_run";
DROP TABLE IF EXISTS "delivery_parity_metric_sample";
DROP TABLE IF EXISTS "delivery_loop_dispatch_intent";
DROP TABLE IF EXISTS "delivery_outbox_v3";
DROP TABLE IF EXISTS "delivery_timer_ledger_v3";
DROP TABLE IF EXISTS "delivery_effect_ledger_v3";
DROP TABLE IF EXISTS "delivery_loop_journal_v3";
DROP TABLE IF EXISTS "delivery_workflow_head_v3";
DROP TABLE IF EXISTS "delivery_workflow_retrospective";
DROP TABLE IF EXISTS "delivery_loop_incident";
DROP TABLE IF EXISTS "delivery_workflow";
