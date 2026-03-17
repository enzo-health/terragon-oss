import type { DB } from "@terragon/shared/db";
import {
  getActiveWorkflowForThread,
  getWorkflow,
} from "@terragon/shared/delivery-loop/store/workflow-store";

/**
 * Resolve loop-like metadata for a work item from the v2 workflow.
 * Returns `{ id, repoFullName }` so callers can key signals and
 * poll GitHub CI without touching the legacy sdlcLoop table.
 *
 * When `loopId` is provided it is returned as-is (the caller already
 * resolved the canonical id). Otherwise the active workflow for the
 * thread is looked up.
 */
export async function resolveLoopForWorker(params: {
  db: DB;
  loopId?: string;
  threadId: string;
}): Promise<{ id: string; repoFullName: string } | null> {
  if (params.loopId) {
    const wf = await getWorkflow({ db: params.db, workflowId: params.loopId });
    return wf
      ? { id: wf.id, repoFullName: wf.repoFullName ?? "" }
      : { id: params.loopId, repoFullName: "" };
  }

  const wf = await getActiveWorkflowForThread({
    db: params.db,
    threadId: params.threadId,
  });
  if (!wf) return null;
  return { id: wf.id, repoFullName: wf.repoFullName ?? "" };
}

/** Stringify an error for logging / work item failure messages. */
export function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
