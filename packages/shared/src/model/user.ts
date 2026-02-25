import { eq, and, sql, desc } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { publishBroadcastUserMessage } from "../broadcast-server";
import { UserInfoServerSide, UserSettings } from "../db/types";
import {
  decryptTokenWithBackwardsCompatibility,
  encryptToken,
} from "@terragon/utils/encryption";

export async function getGitHubUserAccessTokenOrThrow({
  db,
  userId,
  encryptionKey,
  clientId,
  clientSecret,
}: {
  db: DB;
  userId: string;
  encryptionKey: string;
  clientId?: string;
  clientSecret?: string;
}) {
  const githubAccounts = await db
    .select()
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, "github"),
      ),
    )
    .execute();
  if (githubAccounts.length === 0) {
    throw new Error("No GitHub account found");
  }
  const githubAccount = githubAccounts[0]!;

  if (!githubAccount.accessToken) {
    throw new Error("No GitHub access token found");
  }

  // Check if token is expired (or expiring within 5 minutes) and refresh if possible
  const isExpired =
    githubAccount.accessTokenExpiresAt != null &&
    githubAccount.accessTokenExpiresAt.getTime() < Date.now() + 5 * 60 * 1000;

  if (isExpired && clientId && clientSecret && githubAccount.refreshToken) {
    try {
      const refreshToken = decryptTokenWithBackwardsCompatibility(
        githubAccount.refreshToken,
        encryptionKey,
      );
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }).toString(),
        },
      );
      const data = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
      };
      if (data.access_token) {
        await db
          .update(schema.account)
          .set({
            accessToken: encryptToken(data.access_token, encryptionKey),
            ...(data.refresh_token && {
              refreshToken: encryptToken(data.refresh_token, encryptionKey),
            }),
            ...(data.expires_in && {
              accessTokenExpiresAt: new Date(
                Date.now() + data.expires_in * 1000,
              ),
            }),
            ...(data.refresh_token_expires_in && {
              refreshTokenExpiresAt: new Date(
                Date.now() + data.refresh_token_expires_in * 1000,
              ),
            }),
          })
          .where(eq(schema.account.id, githubAccount.id));
        return data.access_token;
      }
    } catch (refreshError) {
      console.error("Failed to refresh GitHub token:", refreshError);
    }
  }

  // Decrypt the token if it's encrypted, otherwise return as-is (backwards compatibility)
  return decryptTokenWithBackwardsCompatibility(
    githubAccount.accessToken,
    encryptionKey,
  );
}

export async function getUser({ db, userId }: { db: DB; userId: string }) {
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
  });
  return user;
}

export async function getUserSettings({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<UserSettings> {
  let userSettings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
  });
  if (!userSettings) {
    // Use onConflictDoNothing to handle race condition when multiple
    // parallel calls try to create user settings simultaneously
    const result = await db
      .insert(schema.userSettings)
      .values({
        userId,
      })
      .onConflictDoNothing()
      .returning();
    // If the insert was skipped due to conflict, fetch the existing record
    if (result.length === 0) {
      userSettings = await db.query.userSettings.findFirst({
        where: eq(schema.userSettings.userId, userId),
      });
    } else {
      userSettings = result[0]!;
    }
  }
  return userSettings!;
}

export async function updateUserSettings({
  db,
  userId,
  updates,
}: {
  db: DB;
  userId: string;
  updates: Partial<typeof schema.userSettings.$inferSelect>;
}) {
  if ("userId" in updates || "id" in updates) {
    throw new Error("userId and id cannot be updated");
  }
  await db
    .insert(schema.userSettings)
    .values({
      userId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [schema.userSettings.userId],
      set: {
        ...updates,
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      userSettings: true,
    },
  });
}

export async function getUserInfoServerSide({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<UserInfoServerSide> {
  let userInfoServerSide = await db.query.userInfoServerSide.findFirst({
    where: eq(schema.userInfoServerSide.userId, userId),
  });
  if (!userInfoServerSide) {
    const result = await db
      .insert(schema.userInfoServerSide)
      .values({
        userId,
      })
      .onConflictDoNothing()
      .returning();
    if (result.length === 0) {
      userInfoServerSide = await db.query.userInfoServerSide.findFirst({
        where: eq(schema.userInfoServerSide.userId, userId),
      });
    } else {
      userInfoServerSide = result[0]!;
    }
  }
  return userInfoServerSide!;
}

export async function updateUserInfoServerSide({
  db,
  userId,
  updates,
}: {
  db: DB;
  userId: string;
  updates: Partial<typeof schema.userInfoServerSide.$inferSelect>;
}) {
  await db
    .insert(schema.userInfoServerSide)
    .values({
      userId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [schema.userInfoServerSide.userId],
      set: {
        ...updates,
      },
    });
}
export async function isValidUserId({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: {
      id: true,
    },
  });
  return !!user;
}

export async function getUserIdByGitHubAccountId({
  db,
  accountId,
}: {
  db: DB;
  accountId: string;
}) {
  const account = await db.query.account.findFirst({
    where: and(
      eq(schema.account.accountId, accountId),
      eq(schema.account.providerId, "github"),
    ),
    columns: {
      userId: true,
    },
  });
  return account?.userId;
}

export async function getGitHubAccountIdForUser({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  const account = await db.query.account.findFirst({
    where: and(
      eq(schema.account.userId, userId),
      eq(schema.account.providerId, "github"),
    ),
    columns: {
      accountId: true,
    },
  });
  return account?.accountId;
}

export async function getRecentUsersForAdmin({
  db,
  limit,
}: {
  db: DB;
  limit: number;
}) {
  // Get users with their most recent thread creation date
  return await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      createdAt: schema.user.createdAt,
      role: schema.user.role,
      mostRecentThreadDate:
        sql<Date>`MAX(${schema.thread.createdAt} AT TIME ZONE 'UTC')`.as(
          "most_recent_thread_date",
        ),
    })
    .from(schema.user)
    .leftJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
    .groupBy(schema.user.id)
    .orderBy(
      desc(sql`CASE WHEN ${schema.user.role} = 'admin' THEN 1 ELSE 0 END`),
      desc(
        sql`COALESCE(MAX(${schema.thread.createdAt} AT TIME ZONE 'UTC'), '1970-01-01'::timestamp AT TIME ZONE 'UTC')`,
      ),
    )
    .limit(limit);
}

export async function updateUser({
  db,
  userId,
  updates,
}: {
  db: DB;
  userId: string;
  updates: Partial<
    Pick<
      typeof schema.user.$inferSelect,
      "stripeCustomerId" | "signupTrialPlan"
    >
  >;
}) {
  await db.update(schema.user).set(updates).where(eq(schema.user.id, userId));
}
