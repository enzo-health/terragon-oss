import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { publishBroadcastUserMessage } from "../broadcast-server";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  SlackAccount,
  SlackAccountInsert,
  SlackAccountWithMetadata,
  SlackInstallation,
  SlackInstallationInsert,
  SlackSettings,
  SlackSettingsInsert,
} from "../db/types";

function getSlackAccountPublicColumns() {
  const { accessTokenEncrypted: _accessTokenEncrypted, ...columns } =
    getTableColumns(schema.slackAccount);
  return columns;
}

function getSlackInstallationPublicColumns() {
  const {
    botAccessTokenEncrypted: _botAccessTokenEncrypted,
    installerUserId: _installerUserId,
    enterpriseId: _enterpriseId,
    ...columns
  } = getTableColumns(schema.slackInstallation);
  return columns;
}

export async function getSlackAccounts({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<SlackAccountWithMetadata[]> {
  const result = await db
    .select({
      ...getSlackAccountPublicColumns(),
      installation: getSlackInstallationPublicColumns(),
      settings: schema.slackSettings,
    })
    .from(schema.slackAccount)
    .leftJoin(
      schema.slackInstallation,
      eq(schema.slackAccount.teamId, schema.slackInstallation.teamId),
    )
    .leftJoin(
      schema.slackSettings,
      and(
        eq(schema.slackAccount.userId, schema.slackSettings.userId),
        eq(schema.slackAccount.teamId, schema.slackSettings.teamId),
      ),
    )
    .where(eq(schema.slackAccount.userId, userId));
  return result;
}

export async function getSlackAccountForSlackUserId({
  db,
  teamId,
  slackUserId,
}: {
  db: DB;
  teamId: string;
  slackUserId: string;
}): Promise<SlackAccount | null> {
  const result = await db.query.slackAccount.findFirst({
    where: and(
      eq(schema.slackAccount.slackUserId, slackUserId),
      eq(schema.slackAccount.teamId, teamId),
    ),
  });
  return result || null;
}

export async function getSlackAccountForTeam({
  db,
  userId,
  teamId,
}: {
  db: DB;
  userId: string;
  teamId: string;
}): Promise<SlackAccount | null> {
  const result = await db.query.slackAccount.findFirst({
    where: and(
      eq(schema.slackAccount.userId, userId),
      eq(schema.slackAccount.teamId, teamId),
    ),
  });
  return result || null;
}

export async function getSlackSettingsForTeam({
  db,
  userId,
  teamId,
}: {
  db: DB;
  userId: string;
  teamId: string;
}): Promise<SlackSettings | null> {
  const result = await db.query.slackSettings.findFirst({
    where: and(
      eq(schema.slackSettings.userId, userId),
      eq(schema.slackSettings.teamId, teamId),
    ),
  });
  return result || null;
}

export async function upsertSlackAccount({
  db,
  userId,
  teamId,
  account,
}: {
  db: DB;
  userId: string;
  teamId: string;
  account: Omit<SlackAccountInsert, "userId" | "teamId">;
}) {
  await db
    .insert(schema.slackAccount)
    .values({
      ...account,
      userId,
      teamId,
    })
    .onConflictDoUpdate({
      target: [schema.slackAccount.userId, schema.slackAccount.teamId],
      set: {
        ...account,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { slack: true },
  });
}

export async function deleteSlackAccount({
  db,
  userId,
  teamId,
}: {
  db: DB;
  userId: string;
  teamId: string;
}) {
  await db.transaction(async (tx) => {
    const where = and(
      eq(schema.slackAccount.userId, userId),
      eq(schema.slackAccount.teamId, teamId),
    );
    await tx
      .delete(schema.slackSettings)
      .where(
        and(
          eq(schema.slackSettings.userId, userId),
          eq(schema.slackSettings.teamId, teamId),
        ),
      );
    await tx.delete(schema.slackAccount).where(where);
  });
}

export async function getSlackInstallationForTeam({
  db,
  teamId,
}: {
  db: DB;
  teamId: string;
}): Promise<SlackInstallation | null> {
  const installation = await db.query.slackInstallation.findFirst({
    where: eq(schema.slackInstallation.teamId, teamId),
  });
  return installation || null;
}

export async function upsertSlackInstallation({
  db,
  userId,
  teamId,
  installation,
}: {
  db: DB;
  userId: string;
  teamId: string;
  installation: Omit<SlackInstallationInsert, "teamId">;
}) {
  const account = await getSlackAccountForTeam({ db, userId, teamId });
  if (!account) {
    throw new Error("User is not part of this team");
  }
  await db
    .insert(schema.slackInstallation)
    .values({
      ...installation,
      teamId,
    })
    .onConflictDoUpdate({
      target: [schema.slackInstallation.teamId],
      set: {
        ...installation,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { slack: true },
  });
}

export async function upsertSlackSettings({
  db,
  userId,
  teamId,
  settings,
}: {
  db: DB;
  userId: string;
  teamId: string;
  settings: Omit<SlackSettingsInsert, "userId" | "teamId">;
}) {
  const account = await getSlackAccountForTeam({ db, userId, teamId });
  if (!account) {
    throw new Error("Slack account is not linked");
  }
  await db
    .insert(schema.slackSettings)
    .values({
      ...settings,
      userId,
      teamId,
    })
    .onConflictDoUpdate({
      target: [schema.slackSettings.userId, schema.slackSettings.teamId],
      set: {
        ...settings,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { slack: true },
  });
}

export async function getSlackAccountAndInstallationForWorkspace({
  db,
  userId,
  workspaceDomain,
}: {
  db: DB;
  userId: string;
  workspaceDomain: string;
}): Promise<{
  slackAccount: SlackAccount | null;
  slackInstallation: SlackInstallation | null;
}> {
  const slackAccount = await db.query.slackAccount.findFirst({
    where: and(
      eq(schema.slackAccount.userId, userId),
      eq(schema.slackAccount.slackTeamDomain, workspaceDomain),
    ),
  });
  if (!slackAccount) {
    return { slackAccount: null, slackInstallation: null };
  }
  const slackInstallation = await getSlackInstallationForTeam({
    db,
    teamId: slackAccount.teamId,
  });
  return { slackAccount, slackInstallation: slackInstallation || null };
}

export async function getSlackInstallationsForAdmin({ db }: { db: DB }) {
  return await db
    .select(getSlackInstallationPublicColumns())
    .from(schema.slackInstallation)
    .orderBy(desc(schema.slackInstallation.createdAt));
}
