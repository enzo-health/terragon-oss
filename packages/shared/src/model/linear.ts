import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { DB } from "../db";
import type {
  LinearAccount,
  LinearAccountInsert,
  LinearAccountWithSettings,
  LinearInstallation,
  LinearInstallationInsert,
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
 * Atomically claim a Linear webhook delivery ID for processing.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING so that the first caller to arrive
 * "wins" the delivery ID and receives `{ claimed: true }`.
 * Any concurrent or subsequent caller for the same ID receives `{ claimed: false }`,
 * which the handler should treat as "already processed — skip".
 *
 * This is the recommended idempotency primitive for Linear webhook handlers
 * because it is safe under any connection-pool configuration and does not
 * rely on advisory locks being issued on the same physical connection.
 */
export async function claimLinearWebhookDelivery({
  db,
  deliveryId,
}: {
  db: DB;
  deliveryId: string;
}): Promise<{ claimed: boolean }> {
  const result = await db
    .insert(schema.linearWebhookDeliveries)
    .values({ deliveryId })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.linearWebhookDeliveries.deliveryId });

  return { claimed: result.length > 0 };
}
