import type { DB } from "@terragon/shared/db";
import { eq, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";

/**
 * Resolve the sdlcLoop for a work item. Uses the explicit loopId from
 * the payload when available, otherwise falls back to the most recent
 * loop for the given threadId.
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
  return params.db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.threadId, params.threadId),
    orderBy: [desc(schema.sdlcLoop.createdAt)],
  });
}

/** Stringify an error for logging / work item failure messages. */
export function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
