import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import { inArray, and, gte, countDistinct, eq, sql } from "drizzle-orm";
import { AbuseDetectionTable } from "./table";
import { getUserListForAdminPage, UserForAdminPage } from "@/server-lib/admin";
import { BILLABLE_EVENT_TYPES } from "@terragon/shared/model/credits";

export interface UserWithSharedRepos extends UserForAdminPage {
  sharedRepos: string[];
  sharedRepoCount: number;
  totalCreditsCents: number;
}

export default async function AbuseDetectionPage() {
  await getAdminUserOrThrow();

  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // Query 1: Find all repos with multiple users in the past month
  const reposWithMultipleUsers = await db
    .select({
      githubRepoFullName: schema.thread.githubRepoFullName,
      userCount: countDistinct(schema.thread.userId),
    })
    .from(schema.thread)
    .where(gte(schema.thread.createdAt, oneMonthAgo))
    .groupBy(schema.thread.githubRepoFullName)
    .having(({ userCount }) => gte(userCount, 2));

  const sharedRepoNames = reposWithMultipleUsers.map(
    (r) => r.githubRepoFullName,
  );

  const threadsOnSharedRepos = await db
    .selectDistinct({
      user: schema.user,
      githubRepoFullName: schema.thread.githubRepoFullName,
    })
    .from(schema.thread)
    .innerJoin(schema.user, eq(schema.thread.userId, schema.user.id))
    .where(
      and(
        inArray(schema.thread.githubRepoFullName, sharedRepoNames),
        gte(schema.thread.createdAt, oneMonthAgo),
      ),
    );

  const creditsUsed = await db
    .select({
      userId: schema.usageEvents.userId,
      totalCents: sql<number>`COALESCE(SUM(${schema.usageEvents.value} * 100)::bigint, 0)`,
    })
    .from(schema.usageEvents)
    .innerJoin(schema.user, eq(schema.usageEvents.userId, schema.user.id))
    .where(
      and(
        inArray(schema.usageEvents.eventType, BILLABLE_EVENT_TYPES),
        inArray(
          schema.usageEvents.userId,
          Array.from(new Set(threadsOnSharedRepos.map((t) => t.user.id))),
        ),
      ),
    )
    .groupBy(schema.usageEvents.userId, schema.user.id);

  // Group repos by user
  const userMap = new Map<
    string,
    {
      user: typeof schema.user.$inferSelect;
      repos: Set<string>;
      totalCreditsCents: number;
    }
  >();
  for (const row of threadsOnSharedRepos) {
    if (!userMap.has(row.user.id)) {
      userMap.set(row.user.id, {
        user: row.user,
        repos: new Set(),
        totalCreditsCents: 0,
      });
    }
    userMap.get(row.user.id)!.repos.add(row.githubRepoFullName);
  }
  for (const row of creditsUsed) {
    if (userMap.has(row.userId)) {
      userMap.get(row.userId)!.totalCreditsCents = Number(row.totalCents ?? 0);
    }
  }

  const users = Array.from(userMap.values()).map((u) => u.user);
  const usersWithAdminData = await getUserListForAdminPage(users);

  // Combine data
  const finalData: UserWithSharedRepos[] = usersWithAdminData.map((user) => {
    const repos = Array.from(userMap.get(user.id)?.repos ?? []).sort();
    return {
      ...user,
      sharedRepos: repos,
      sharedRepoCount: repos.length,
      totalCreditsCents: userMap.get(user.id)?.totalCreditsCents ?? 0,
    };
  });

  // Sort by shared repo count descending
  finalData.sort((a, b) => {
    return b.sharedRepoCount - a.sharedRepoCount;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Abuse Detection</h1>
        <p className="text-sm text-muted-foreground">
          Users working on repositories with multiple users in the last 30 days
          (potential shared-repository abuse)
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground">
          Found {finalData.length} users working on shared repositories
        </div>
        <AbuseDetectionTable data={finalData} />
      </div>
    </div>
  );
}
