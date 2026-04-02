-- Persist delivery workflow linkage on daemon run context rows so terminal
-- daemon events can fence against the leased run sequence deterministically.

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "workflow_id" text;

ALTER TABLE "agent_run_context"
  ADD COLUMN IF NOT EXISTS "run_seq" bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_run_context_workflow_id_delivery_workflow_id_fk'
  ) THEN
    ALTER TABLE "agent_run_context"
      ADD CONSTRAINT "agent_run_context_workflow_id_delivery_workflow_id_fk"
      FOREIGN KEY ("workflow_id")
      REFERENCES "public"."delivery_workflow"("id")
      ON DELETE set null
      ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "agent_run_context_workflow_run_seq_idx"
  ON "agent_run_context" USING btree ("workflow_id", "run_seq");
