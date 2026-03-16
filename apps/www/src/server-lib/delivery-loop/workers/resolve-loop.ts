import type { DB } from "@terragon/shared/db";
import { eq, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";

/**
 * Resolve the sdlcLoop for a work item. Uses the explicit loopId from
 * the payload when available. When looking up by threadId, tries the
 * v2 workflow first (to get the authoritative sdlcLoopId) then falls
 * back to the most recent v1 sdlcLoop row.
 */
export async function resolveLoopForWorker(params: {
  db: DB;
  loopId?: string;
  threadId: string;
}) {
  if (params.loopId) {
    return params.db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, params.loopId),
    });
  }

  // V2-primary: use the active workflow's sdlcLoopId for a precise lookup
  const v2Workflow = await getActiveWorkflowForThread({
    db: params.db,
    threadId: params.threadId,
  });
  if (v2Workflow?.sdlcLoopId) {
    const loop = await params.db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, v2Workflow.sdlcLoopId),
    });
    if (loop) {
      return loop;
    }
  }

  // V1 fallback: most recent loop for the thread
  return params.db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.threadId, params.threadId),
    orderBy: [desc(schema.sdlcLoop.createdAt)],
  });
}

/** Stringify an error for logging / work item failure messages. */
export function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
