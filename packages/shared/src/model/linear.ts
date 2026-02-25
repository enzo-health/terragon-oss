import { and, desc, eq, getTableColumns, isNull, lt } from "drizzle-orm";
import * as schema from "../db/schema";
import type { DB } from "../db";
import type {
  LinearAccount,
  LinearAccountInsert,
  LinearAccountWithSettings,
  LinearInstallation,
  LinearInstallationInsert,
  LinearInstallationPublic,
  LinearSettings,
  LinearSettingsInsert,
} from "../db/types";
import { publishBroadcastUserMessage } from "../broadcast-server";

export async function getLinearAccountForLinearUserId({
  db,
  organizationId,
  linearUserId,
}: {
  db: DB;
  organizationId: string;
  linearUserId: string;
}): Promise<LinearAccount | null> {
  const result = await db.query.linearAccount.findFirst({
    where: and(
      eq(schema.linearAccount.linearUserId, linearUserId),
      eq(schema.linearAccount.organizationId, organizationId),
    ),
  });
  return result || null;
}

export async function getLinearAccounts({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<LinearAccount[]> {
  const result = await db
    .select()
    .from(schema.linearAccount)
    .where(eq(schema.linearAccount.userId, userId));
  return result;
}

export async function getLinearAccountsWithSettings({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<LinearAccountWithSettings[]> {
  const result = await db
    .select({
      ...getTableColumns(schema.linearAccount),
      settings: schema.linearSettings,
    })
    .from(schema.linearAccount)
    .leftJoin(
      schema.linearSettings,
      and(
        eq(schema.linearAccount.userId, schema.linearSettings.userId),
        eq(
          schema.linearAccount.organizationId,
          schema.linearSettings.organizationId,
        ),
      ),
    )
    .where(eq(schema.linearAccount.userId, userId));
  return result;
}

export async function upsertLinearAccount({
  db,
  userId,
  organizationId,
  account,
}: {
  db: DB;
  userId: string;
  organizationId: string;
  account: Omit<LinearAccountInsert, "userId" | "organizationId">;
}) {
  await db
    .insert(schema.linearAccount)
    .values({
      ...account,
      userId,
      organizationId,
    })
    .onConflictDoUpdate({
      target: [
        schema.linearAccount.userId,
        schema.linearAccount.organizationId,
      ],
      set: {
        ...account,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { linear: true },
  });
}

export async function deleteLinearAccount({
  db,
  userId,
  organizationId,
}: {
  db: DB;
  userId: string;
  organizationId: string;
}) {
  await db
    .delete(schema.linearAccount)
    .where(
      and(
        eq(schema.linearAccount.userId, userId),
        eq(schema.linearAccount.organizationId, organizationId),
      ),
    );
}

export async function disconnectLinearAccountAndSettings({
  db,
  userId,
  organizationId,
}: {
  db: DB;
  userId: string;
  organizationId: string;
}) {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.linearSettings)
      .where(
        and(
          eq(schema.linearSettings.userId, userId),
          eq(schema.linearSettings.organizationId, organizationId),
        ),
      );
    await tx
      .delete(schema.linearAccount)
      .where(
        and(
          eq(schema.linearAccount.userId, userId),
          eq(schema.linearAccount.organizationId, organizationId),
        ),
      );
  });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { linear: true },
  });
}

export async function getLinearSettingsForUserAndOrg({
  db,
  userId,
  organizationId,
}: {
  db: DB;
  userId: string;
  organizationId: string;
}): Promise<LinearSettings | null> {
  const result = await db.query.linearSettings.findFirst({
    where: and(
      eq(schema.linearSettings.userId, userId),
      eq(schema.linearSettings.organizationId, organizationId),
    ),
  });
  return result || null;
}

export async function upsertLinearSettings({
  db,
  userId,
  organizationId,
  settings,
}: {
  db: DB;
  userId: string;
  organizationId: string;
  settings: Omit<LinearSettingsInsert, "userId" | "organizationId">;
}) {
  await db
    .insert(schema.linearSettings)
    .values({
      ...settings,
      userId,
      organizationId,
    })
    .onConflictDoUpdate({
      target: [
        schema.linearSettings.userId,
        schema.linearSettings.organizationId,
      ],
      set: {
        ...settings,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { linear: true },
  });
}

export async function deleteLinearSettings({
  db,
  userId,
  organizationId,
}: {
  db: DB;
  userId: string;
  organizationId: string;
}) {
  await db
    .delete(schema.linearSettings)
    .where(
      and(
        eq(schema.linearSettings.userId, userId),
        eq(schema.linearSettings.organizationId, organizationId),
      ),
    );
}

// ── LinearInstallation CRUD ──────────────────────────────────────────────────

// Returns the single workspace-level installation as a UI-safe projection that
// omits encrypted token fields. Safe to pass across the RSC → client boundary.
// Fetches the most recently updated record to handle edge-cases where multiple
// records exist during migration.
export async function getLinearInstallation({
  db,
}: {
  db: DB;
}): Promise<LinearInstallationPublic | null> {
  const result = await db
    .select({
      id: schema.linearInstallation.id,
      organizationId: schema.linearInstallation.organizationId,
      organizationName: schema.linearInstallation.organizationName,
      tokenExpiresAt: schema.linearInstallation.tokenExpiresAt,
      isActive: schema.linearInstallation.isActive,
      createdAt: schema.linearInstallation.createdAt,
      updatedAt: schema.linearInstallation.updatedAt,
    })
    .from(schema.linearInstallation)
    .orderBy(desc(schema.linearInstallation.updatedAt))
    .limit(1);
  return result[0] ?? null;
}

export async function getLinearInstallationForOrg({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<LinearInstallation | null> {
  const result = await db.query.linearInstallation.findFirst({
    where: eq(schema.linearInstallation.organizationId, organizationId),
  });
  return result ?? null;
}

export async function upsertLinearInstallation({
  db,
  installation,
}: {
  db: DB;
  installation: LinearInstallationInsert;
}): Promise<LinearInstallation> {
  const [result] = await db
    .insert(schema.linearInstallation)
    .values(installation)
    .onConflictDoUpdate({
      target: [schema.linearInstallation.organizationId],
      set: {
        organizationName: installation.organizationName,
        accessTokenEncrypted: installation.accessTokenEncrypted,
        refreshTokenEncrypted: installation.refreshTokenEncrypted,
        tokenExpiresAt: installation.tokenExpiresAt,
        scope: installation.scope,
        installerUserId: installation.installerUserId,
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result!;
}

export async function deactivateLinearInstallation({
  db,
  organizationId,
  /** CAS guard: only deactivate if access token matches observed value */
  ifAccessTokenEncrypted,
}: {
  db: DB;
  organizationId: string;
  ifAccessTokenEncrypted?: string;
}): Promise<{ deactivated: boolean }> {
  const conditions = [
    eq(schema.linearInstallation.organizationId, organizationId),
    eq(schema.linearInstallation.isActive, true),
  ];
  if (ifAccessTokenEncrypted !== undefined) {
    // CAS guard: only deactivate if the observed token still matches.
    // A concurrent reinstall/refresh will have updated the token, so this
    // stale-read deactivation will become a no-op.
    conditions.push(
      eq(
        schema.linearInstallation.accessTokenEncrypted,
        ifAccessTokenEncrypted,
      ),
    );
  }
  const result = await db
    .update(schema.linearInstallation)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: schema.linearInstallation.id });
  return { deactivated: result.length > 0 };
}

export async function updateLinearInstallationTokens({
  db,
  organizationId,
  accessTokenEncrypted,
  refreshTokenEncrypted,
  tokenExpiresAt,
  /** The previous tokenExpiresAt value for optimistic CAS guard */
  previousTokenExpiresAt,
}: {
  db: DB;
  organizationId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string | null;
  tokenExpiresAt: Date | null;
  previousTokenExpiresAt?: Date | null;
}): Promise<{ updated: boolean }> {
  const conditions = [
    eq(schema.linearInstallation.organizationId, organizationId),
    // Only refresh active installations — a concurrent deactivation must win
    eq(schema.linearInstallation.isActive, true),
  ];

  // DB-level optimistic CAS: only update if tokenExpiresAt hasn't changed
  // (another instance may have already refreshed it)
  if (previousTokenExpiresAt !== undefined) {
    if (previousTokenExpiresAt === null) {
      conditions.push(isNull(schema.linearInstallation.tokenExpiresAt));
    } else {
      conditions.push(
        eq(schema.linearInstallation.tokenExpiresAt, previousTokenExpiresAt),
      );
    }
  }

  const result = await db
    .update(schema.linearInstallation)
    .set({
      accessTokenEncrypted,
      ...(refreshTokenEncrypted !== undefined ? { refreshTokenEncrypted } : {}),
      tokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ id: schema.linearInstallation.id });

  return { updated: result.length > 0 };
}

/**
 * Claim window: how long a non-completed row must be "stale" before another
 * handler is allowed to steal it (i.e. assume the original crashed).
 * Linear's minimum retry interval is ~5 minutes, so any in-progress row
 * younger than this is almost certainly a concurrent delivery — not a crash.
 */
const CLAIM_STEAL_AFTER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Attempt to claim a Linear webhook delivery ID for processing.
 *
 * Inserts a row with `completedAt = NULL` (in-progress marker).
 * On conflict (duplicate delivery ID), applies TTL-based steal logic:
 *
 *   - `completedAt IS NOT NULL`                     → already processed; `{ claimed: false }`.
 *   - `completedAt IS NULL`, `createdAt` < 5 min ago → concurrent in-progress handler;
 *                                                      yield to it: `{ claimed: false }`.
 *   - `completedAt IS NULL`, `createdAt` ≥ 5 min ago → stale/crashed handler;
 *                                                      steal: delete + re-insert → `{ claimed: true }`.
 *
 * The TTL threshold prevents two concurrent handlers (arriving within seconds of each
 * other) from both claiming the same delivery.  Linear retries are spaced at least
 * 5 minutes apart, so a legitimate retry from a crashed handler will always see a
 * sufficiently old row.
 *
 * Returns `{ claimed: true }` if the caller should proceed with thread creation.
 * Returns `{ claimed: false }` if processing should be skipped (already done or concurrent).
 */
export async function claimLinearWebhookDelivery({
  db,
  deliveryId,
}: {
  db: DB;
  deliveryId: string;
}): Promise<{ claimed: boolean }> {
  // Attempt fresh insert
  const inserted = await db
    .insert(schema.linearWebhookDeliveries)
    .values({ deliveryId })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.linearWebhookDeliveries.deliveryId });

  if (inserted.length > 0) {
    // New row — this caller owns the delivery.
    return { claimed: true };
  }

  // Row already exists — check completedAt and age.
  const existing = await db.query.linearWebhookDeliveries.findFirst({
    where: eq(schema.linearWebhookDeliveries.deliveryId, deliveryId),
  });

  if (!existing) {
    // Race: row was deleted between our conflict and this read.
    // Another handler cleaned it up; treat as not-our-problem.
    return { claimed: false };
  }

  if (existing.completedAt !== null) {
    // Already successfully processed — skip.
    return { claimed: false };
  }

  // Row is in-progress (completedAt IS NULL).
  // Only steal if the row is old enough to indicate a crashed handler.
  const staleThreshold = new Date(Date.now() - CLAIM_STEAL_AFTER_MS);
  if (existing.createdAt >= staleThreshold) {
    // Row is fresh — a concurrent handler is actively processing this delivery.
    // Yield to it to prevent duplicate thread creation.
    return { claimed: false };
  }

  // Row is stale (≥ 5 min old, completedAt still NULL) → the original handler crashed.
  // Steal: delete the stale row (CAS on completedAt IS NULL to guard against a
  // late-arriving completion from the original handler) then re-insert.
  const deleted = await db
    .delete(schema.linearWebhookDeliveries)
    .where(
      and(
        eq(schema.linearWebhookDeliveries.deliveryId, deliveryId),
        isNull(schema.linearWebhookDeliveries.completedAt),
        lt(schema.linearWebhookDeliveries.createdAt, staleThreshold),
      ),
    )
    .returning({ deliveryId: schema.linearWebhookDeliveries.deliveryId });

  if (deleted.length === 0) {
    // Another handler raced us to claim or complete between our read and delete.
    return { claimed: false };
  }

  // Re-insert for this attempt; if we lose a tight race here, yield.
  const reinserted = await db
    .insert(schema.linearWebhookDeliveries)
    .values({ deliveryId })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.linearWebhookDeliveries.deliveryId });

  return { claimed: reinserted.length > 0 };
}

/**
 * Mark a Linear webhook delivery as successfully completed.
 * Call this AFTER thread creation succeeds.
 * Subsequent retries for the same deliveryId will see `completedAt IS NOT NULL` and skip.
 */
export async function completeLinearWebhookDelivery({
  db,
  deliveryId,
  threadId,
}: {
  db: DB;
  deliveryId: string;
  threadId: string;
}): Promise<void> {
  await db
    .update(schema.linearWebhookDeliveries)
    .set({ completedAt: new Date(), threadId })
    .where(eq(schema.linearWebhookDeliveries.deliveryId, deliveryId));
}
