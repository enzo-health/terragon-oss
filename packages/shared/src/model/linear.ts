import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { DB } from "../db";
import type {
  LinearAccount,
  LinearAccountInsert,
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
