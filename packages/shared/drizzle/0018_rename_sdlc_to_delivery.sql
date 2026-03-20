-- Rename sdlc_ tables to delivery_ to match the schema
ALTER TABLE "sdlc_phase_artifact" RENAME TO "delivery_phase_artifact";
--> statement-breakpoint
ALTER TABLE "sdlc_plan_task" RENAME TO "delivery_plan_task";
--> statement-breakpoint
ALTER TABLE "sdlc_loop_signal_inbox" RENAME TO "delivery_signal_inbox";
--> statement-breakpoint
ALTER TABLE "sdlc_deep_review_run" RENAME TO "delivery_deep_review_run";
--> statement-breakpoint
ALTER TABLE "sdlc_deep_review_finding" RENAME TO "delivery_deep_review_finding";
--> statement-breakpoint
ALTER TABLE "sdlc_carmack_review_run" RENAME TO "delivery_carmack_review_run";
--> statement-breakpoint
ALTER TABLE "sdlc_carmack_review_finding" RENAME TO "delivery_carmack_review_finding";
--> statement-breakpoint
ALTER TABLE "sdlc_ci_gate_run" RENAME TO "delivery_ci_gate_run";
--> statement-breakpoint
ALTER TABLE "sdlc_review_thread_gate_run" RENAME TO "delivery_review_thread_gate_run";
--> statement-breakpoint
ALTER TABLE "sdlc_parity_metric_sample" RENAME TO "delivery_parity_metric_sample";
--> statement-breakpoint
-- Rename indexes: sdlc_phase_artifact
ALTER INDEX "sdlc_phase_artifact_pkey" RENAME TO "delivery_phase_artifact_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_phase_artifact_loop_phase_created_index" RENAME TO "delivery_phase_artifact_loop_phase_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_phase_artifact_loop_phase_status_created_index" RENAME TO "delivery_phase_artifact_loop_phase_status_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_phase_artifact_loop_head_phase_created_index" RENAME TO "delivery_phase_artifact_loop_head_phase_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_phase_artifact_workflow_id_index" RENAME TO "delivery_phase_artifact_workflow_id_index";
--> statement-breakpoint
-- Rename indexes: sdlc_plan_task
ALTER INDEX "sdlc_plan_task_pkey" RENAME TO "delivery_plan_task_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_plan_task_artifact_stable_task_unique" RENAME TO "delivery_plan_task_artifact_stable_task_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_plan_task_loop_status_index" RENAME TO "delivery_plan_task_loop_status_index";
--> statement-breakpoint
ALTER INDEX "sdlc_plan_task_loop_artifact_status_index" RENAME TO "delivery_plan_task_loop_artifact_status_index";
--> statement-breakpoint
-- Rename indexes: sdlc_loop_signal_inbox -> delivery_signal_inbox
ALTER INDEX "sdlc_loop_signal_inbox_pkey" RENAME TO "delivery_signal_inbox_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_loop_signal_inbox_dedupe_unique" RENAME TO "delivery_signal_inbox_dedupe_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_loop_signal_inbox_dedupe_null_head_unique" RENAME TO "delivery_signal_inbox_dedupe_null_head_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_loop_signal_inbox_claimable_unclaimed_index" RENAME TO "delivery_signal_inbox_claimable_unclaimed_index";
--> statement-breakpoint
ALTER INDEX "sdlc_loop_signal_inbox_claimable_stale_index" RENAME TO "delivery_signal_inbox_claimable_stale_index";
--> statement-breakpoint
ALTER INDEX "sdlc_loop_signal_inbox_loop_received_index" RENAME TO "delivery_signal_inbox_loop_received_index";
--> statement-breakpoint
-- Rename indexes: sdlc_deep_review_run
ALTER INDEX "sdlc_deep_review_run_pkey" RENAME TO "delivery_deep_review_run_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_deep_review_run_loop_head_unique" RENAME TO "delivery_deep_review_run_loop_head_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_deep_review_run_loop_created_index" RENAME TO "delivery_deep_review_run_loop_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_deep_review_run_status_index" RENAME TO "delivery_deep_review_run_status_index";
--> statement-breakpoint
-- Rename indexes: sdlc_deep_review_finding
ALTER INDEX "sdlc_deep_review_finding_pkey" RENAME TO "delivery_deep_review_finding_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_deep_review_finding_loop_head_stable_unique" RENAME TO "delivery_deep_review_finding_loop_head_stable_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_deep_review_finding_loop_head_blocking_index" RENAME TO "delivery_deep_review_finding_loop_head_blocking_index";
--> statement-breakpoint
ALTER INDEX "sdlc_deep_review_finding_run_id_index" RENAME TO "delivery_deep_review_finding_run_id_index";
--> statement-breakpoint
-- Rename indexes: sdlc_carmack_review_run
ALTER INDEX "sdlc_carmack_review_run_pkey" RENAME TO "delivery_carmack_review_run_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_carmack_review_run_loop_head_unique" RENAME TO "delivery_carmack_review_run_loop_head_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_carmack_review_run_loop_created_index" RENAME TO "delivery_carmack_review_run_loop_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_carmack_review_run_status_index" RENAME TO "delivery_carmack_review_run_status_index";
--> statement-breakpoint
-- Rename indexes: sdlc_carmack_review_finding
ALTER INDEX "sdlc_carmack_review_finding_pkey" RENAME TO "delivery_carmack_review_finding_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_carmack_review_finding_loop_head_stable_unique" RENAME TO "delivery_carmack_review_finding_loop_head_stable_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_carmack_review_finding_loop_head_blocking_index" RENAME TO "delivery_carmack_review_finding_loop_head_blocking_index";
--> statement-breakpoint
ALTER INDEX "sdlc_carmack_review_finding_run_id_index" RENAME TO "delivery_carmack_review_finding_run_id_index";
--> statement-breakpoint
-- Rename indexes: sdlc_ci_gate_run
ALTER INDEX "sdlc_ci_gate_run_pkey" RENAME TO "delivery_ci_gate_run_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_ci_gate_run_loop_head_unique" RENAME TO "delivery_ci_gate_run_loop_head_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_ci_gate_run_idempotency_key_unique" RENAME TO "delivery_ci_gate_run_idempotency_key_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_ci_gate_run_loop_created_index" RENAME TO "delivery_ci_gate_run_loop_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_ci_gate_run_status_index" RENAME TO "delivery_ci_gate_run_status_index";
--> statement-breakpoint
-- Rename indexes: sdlc_review_thread_gate_run
ALTER INDEX "sdlc_review_thread_gate_run_pkey" RENAME TO "delivery_review_thread_gate_run_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_review_thread_gate_run_loop_head_unique" RENAME TO "delivery_review_thread_gate_run_loop_head_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_review_thread_gate_run_idempotency_key_unique" RENAME TO "delivery_review_thread_gate_run_idempotency_key_unique";
--> statement-breakpoint
ALTER INDEX "sdlc_review_thread_gate_run_loop_created_index" RENAME TO "delivery_review_thread_gate_run_loop_created_index";
--> statement-breakpoint
ALTER INDEX "sdlc_review_thread_gate_run_status_index" RENAME TO "delivery_review_thread_gate_run_status_index";
--> statement-breakpoint
-- Rename indexes: sdlc_parity_metric_sample
ALTER INDEX "sdlc_parity_metric_sample_pkey" RENAME TO "delivery_parity_metric_sample_pkey";
--> statement-breakpoint
ALTER INDEX "sdlc_parity_metric_sample_bucket_index" RENAME TO "delivery_parity_metric_sample_bucket_index";
--> statement-breakpoint
ALTER INDEX "sdlc_parity_metric_sample_observed_index" RENAME TO "delivery_parity_metric_sample_observed_index";
--> statement-breakpoint
ALTER INDEX "sdlc_parity_metric_sample_eligible_index" RENAME TO "delivery_parity_metric_sample_eligible_index";
--> statement-breakpoint
-- Rename FK constraints to match drizzle's expected naming
ALTER TABLE "delivery_carmack_review_finding" RENAME CONSTRAINT "sdlc_carmack_review_finding_review_run_id_sdlc_carmack_review_r" TO "delivery_carmack_review_finding_review_run_id_delivery_carmack_r";
--> statement-breakpoint
ALTER TABLE "delivery_deep_review_finding" RENAME CONSTRAINT "sdlc_deep_review_finding_review_run_id_sdlc_deep_review_run_id_" TO "delivery_deep_review_finding_review_run_id_delivery_deep_review_";
--> statement-breakpoint
ALTER TABLE "delivery_phase_artifact" RENAME CONSTRAINT "sdlc_phase_artifact_approved_by_user_id_user_id_fk" TO "delivery_phase_artifact_approved_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_phase_artifact" RENAME CONSTRAINT "sdlc_phase_artifact_workflow_id_delivery_workflow_id_fk" TO "delivery_phase_artifact_workflow_id_delivery_workflow_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_plan_task" RENAME CONSTRAINT "sdlc_plan_task_artifact_id_sdlc_phase_artifact_id_fk" TO "delivery_plan_task_artifact_id_delivery_phase_artifact_id_fk";
