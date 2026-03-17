import { eq } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type { SdlcVideoFailureClass } from "../../db/types";

export type SdlcOutboxErrorClass = SdlcVideoFailureClass | "unknown";

export async function persistSdlcCanonicalStatusCommentReference({
  db,
  loopId,
  commentId,
  commentNodeId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  commentId: string;
  commentNodeId?: string | null;
  now?: Date;
}) {
  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      canonicalStatusCommentId: commentId,
      canonicalStatusCommentNodeId: commentNodeId ?? null,
      canonicalStatusCommentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId))
    .returning();

  return updated;
}

export async function clearSdlcCanonicalStatusCommentReference({
  db,
  loopId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  now?: Date;
}) {
  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      canonicalStatusCommentId: null,
      canonicalStatusCommentNodeId: null,
      canonicalStatusCommentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId))
    .returning();

  return updated;
}

export async function persistSdlcCanonicalCheckRunReference({
  db,
  loopId,
  checkRunId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  checkRunId: number;
  now?: Date;
}) {
  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      canonicalCheckRunId: checkRunId,
      canonicalCheckRunUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId))
    .returning();

  return updated;
}
