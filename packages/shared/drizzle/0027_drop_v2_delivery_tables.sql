-- Drop orphaned v2 delivery loop tables (replaced by v3 equivalents)
-- delivery_workflow_event → replaced by delivery_loop_journal_v3
-- delivery_work_item → replaced by delivery_effect_ledger_v3
-- delivery_loop_runtime_status → replaced by delivery_workflow_head_v3

DROP TABLE IF EXISTS "delivery_workflow_event";
DROP TABLE IF EXISTS "delivery_work_item";
DROP TABLE IF EXISTS "delivery_loop_runtime_status";
