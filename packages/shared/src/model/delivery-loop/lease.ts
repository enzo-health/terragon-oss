import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";

export type SdlcLoopLeaseAcquireResult =
  | {
      acquired: true;
      leaseEpoch: number;
      leaseOwner: string;
      leaseExpiresAt: Date;
    }
  | {
      acquired: false;
      reason: "held_by_other";
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
    };

export async function acquireSdlcLoopLease({
  db,
  loopId,
  leaseOwner,
  leaseTtlMs,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  leaseTtlMs: number;
  now?: Date;
}): Promise<SdlcLoopLeaseAcquireResult> {
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const inserted = await db
    .insert(schema.sdlcLoopLease)
    .values({
      loopId,
      leaseOwner,
      leaseEpoch: 1,
      leaseExpiresAt,
    })
    .onConflictDoNothing()
    .returning({
      leaseEpoch: schema.sdlcLoopLease.leaseEpoch,
      leaseOwner: schema.sdlcLoopLease.leaseOwner,
      leaseExpiresAt: schema.sdlcLoopLease.leaseExpiresAt,
    });

  if (inserted[0]) {
    return {
      acquired: true,
      leaseEpoch: inserted[0].leaseEpoch,
      leaseOwner: inserted[0].leaseOwner ?? leaseOwner,
      leaseExpiresAt: inserted[0].leaseExpiresAt ?? leaseExpiresAt,
    };
  }

  const updated = await db
    .update(schema.sdlcLoopLease)
    .set({
      leaseOwner,
      leaseEpoch: sql`${schema.sdlcLoopLease.leaseEpoch} + 1`,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoopLease.loopId, loopId),
        or(
          eq(schema.sdlcLoopLease.leaseOwner, leaseOwner),
          isNull(schema.sdlcLoopLease.leaseExpiresAt),
          lte(schema.sdlcLoopLease.leaseExpiresAt, now),
        ),
      ),
    )
    .returning({
      leaseEpoch: schema.sdlcLoopLease.leaseEpoch,
      leaseOwner: schema.sdlcLoopLease.leaseOwner,
      leaseExpiresAt: schema.sdlcLoopLease.leaseExpiresAt,
    });

  if (updated[0]) {
    return {
      acquired: true,
      leaseEpoch: updated[0].leaseEpoch,
      leaseOwner: updated[0].leaseOwner ?? leaseOwner,
      leaseExpiresAt: updated[0].leaseExpiresAt ?? leaseExpiresAt,
    };
  }

  const existing = await db.query.sdlcLoopLease.findFirst({
    where: eq(schema.sdlcLoopLease.loopId, loopId),
  });

  return {
    acquired: false,
    reason: "held_by_other",
    leaseOwner: existing?.leaseOwner ?? null,
    leaseExpiresAt: existing?.leaseExpiresAt ?? null,
  };
}

export type SdlcLoopLeaseRefreshResult =
  | { refreshed: true; leaseExpiresAt: Date }
  | {
      refreshed: false;
      reason: "epoch_changed" | "not_owner" | "not_found";
    };

export async function refreshSdlcLoopLease({
  db,
  loopId,
  leaseOwner,
  leaseEpoch,
  leaseTtlMs,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  leaseEpoch: number;
  leaseTtlMs: number;
  now?: Date;
}): Promise<SdlcLoopLeaseRefreshResult> {
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const updated = await db
    .update(schema.sdlcLoopLease)
    .set({
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoopLease.loopId, loopId),
        eq(schema.sdlcLoopLease.leaseOwner, leaseOwner),
        eq(schema.sdlcLoopLease.leaseEpoch, leaseEpoch),
      ),
    )
    .returning({
      leaseExpiresAt: schema.sdlcLoopLease.leaseExpiresAt,
    });

  if (updated[0]) {
    return {
      refreshed: true,
      leaseExpiresAt: updated[0].leaseExpiresAt ?? leaseExpiresAt,
    };
  }

  const existing = await db.query.sdlcLoopLease.findFirst({
    where: eq(schema.sdlcLoopLease.loopId, loopId),
  });

  if (!existing) {
    return { refreshed: false, reason: "not_found" };
  }
  if (existing.leaseOwner !== leaseOwner) {
    return { refreshed: false, reason: "not_owner" };
  }
  return { refreshed: false, reason: "epoch_changed" };
}

export async function releaseSdlcLoopLease({
  db,
  loopId,
  leaseOwner,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  now?: Date;
}) {
  const updated = await db
    .update(schema.sdlcLoopLease)
    .set({
      leaseOwner: null,
      leaseExpiresAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoopLease.loopId, loopId),
        eq(schema.sdlcLoopLease.leaseOwner, leaseOwner),
      ),
    )
    .returning({ loopId: schema.sdlcLoopLease.loopId });

  return updated.length > 0;
}
