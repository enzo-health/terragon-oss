import dynamic from "next/dynamic";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import { desc, eq, sql, count, countDistinct } from "drizzle-orm";
import { getUserListForAdminPage } from "@/server-lib/admin";
import { Skeleton } from "@/components/ui/skeleton";

// Dynamically import the heavy admin users list component
const AdminUsersList = dynamic(
  () => import("@/components/admin/users-list").then((m) => m.AdminUsersList),
  {
    loading: () => (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    ),
  },
);

const LIMIT = 150;

export default async function AdminUsersPage() {
  await getAdminUserOrThrow();

  // Get users with their most recent thread creation date
  const [
    usersWithRecentThread,
    totalUsers,
    totalUsersWithOnboarding,
    totalUsersWithThreads,
    weeklyActiveUsers,
    dailyActiveUsers,
    monthlyActiveUsers,
    recentSignupsLast24Hours,
    recentSignupsLast7Days,
    recentActiveSignupsLast24Hours,
    recentActiveSignupsLast7Days,
    totalPreviewOptIn,
    weeklyActiveUsersByAge,
    userRetentionByAge,
    monthlyActiveUsersByAge,
    monthlyUserRetentionByAge,
  ] = await Promise.all([
    db
      .select({
        user: schema.user,
      })
      .from(schema.user)
      .leftJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
      .groupBy(schema.user.id)
      .orderBy(
        desc(
          sql`COALESCE(MAX(${schema.thread.createdAt} AT TIME ZONE 'UTC'), '1970-01-01'::timestamp AT TIME ZONE 'UTC')`,
        ),
      )
      .limit(LIMIT),
    db.select({ count: count() }).from(schema.user),
    db
      .select({ count: countDistinct(schema.user.id) })
      .from(schema.user)
      .leftJoin(schema.userFlags, eq(schema.user.id, schema.userFlags.userId))
      .where(eq(schema.userFlags.hasSeenOnboarding, true)),
    db
      .select({ count: countDistinct(schema.user.id) })
      .from(schema.user)
      .innerJoin(schema.thread, eq(schema.user.id, schema.thread.userId)),
    db
      .select({ count: countDistinct(schema.user.id) })
      .from(schema.user)
      .innerJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
      .where(sql`${schema.thread.createdAt} >= NOW() - INTERVAL '7 days'`),
    db
      .select({ count: countDistinct(schema.user.id) })
      .from(schema.user)
      .innerJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
      .where(sql`${schema.thread.createdAt} >= NOW() - INTERVAL '1 day'`),
    db
      .select({ count: countDistinct(schema.user.id) })
      .from(schema.user)
      .innerJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
      .where(sql`${schema.thread.createdAt} >= NOW() - INTERVAL '30 days'`),
    db
      .select({ count: count() })
      .from(schema.user)
      .where(sql`${schema.user.createdAt} >= NOW() - INTERVAL '1 day'`),
    db
      .select({ count: count() })
      .from(schema.user)
      .where(sql`${schema.user.createdAt} >= NOW() - INTERVAL '7 days'`),
    db
      .select({ count: countDistinct(schema.thread.userId) })
      .from(schema.user)
      .innerJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
      .where(
        sql`${schema.user.createdAt} >= NOW() - INTERVAL '1 day' AND ${schema.thread.createdAt} >= NOW() - INTERVAL '1 day'`,
      ),
    db
      .select({ count: countDistinct(schema.thread.userId) })
      .from(schema.user)
      .innerJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
      .where(
        sql`${schema.user.createdAt} >= NOW() - INTERVAL '7 days' AND ${schema.thread.createdAt} >= NOW() - INTERVAL '7 days'`,
      ),
    db
      .select({ count: countDistinct(schema.userSettings.userId) })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.previewFeaturesOptIn, true)),
    // Get all users broken down by age (weeks since first thread) with active/inactive status
    db
      .select({
        weeksAgo: sql<number>`
          FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 604800)::int
        `.as("weeks_ago"),
        totalUsers: countDistinct(schema.user.id),
        activeUsers: sql<number>`
          COUNT(DISTINCT CASE
            WHEN recent_thread.user_id IS NOT NULL
            THEN ${schema.user.id}
          END)::int
        `.as("active_users"),
      })
      .from(schema.user)
      .innerJoin(
        db
          .select({
            userId: schema.thread.userId,
            createdAt: sql<Date>`MIN(${schema.thread.createdAt})`.as(
              "created_at",
            ),
          })
          .from(schema.thread)
          .groupBy(schema.thread.userId)
          .as("first_thread"),
        eq(schema.user.id, sql`first_thread.user_id`),
      )
      .leftJoin(
        db
          .selectDistinct({
            userId: schema.thread.userId,
          })
          .from(schema.thread)
          .where(sql`${schema.thread.createdAt} >= NOW() - INTERVAL '7 days'`)
          .as("recent_thread"),
        eq(schema.user.id, sql`recent_thread.user_id`),
      )
      .groupBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 604800)`,
      )
      .orderBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 604800)`,
      ),
    // Get only weekly active users broken down by age (for the original chart)
    db
      .select({
        weeksAgo: sql<number>`
          FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 604800)::int
        `.as("weeks_ago"),
        count: countDistinct(schema.user.id),
      })
      .from(schema.user)
      .innerJoin(
        db
          .select({
            userId: schema.thread.userId,
            createdAt: sql<Date>`MIN(${schema.thread.createdAt})`.as(
              "created_at",
            ),
          })
          .from(schema.thread)
          .groupBy(schema.thread.userId)
          .as("first_thread"),
        eq(schema.user.id, sql`first_thread.user_id`),
      )
      .innerJoin(
        schema.thread,
        sql`${schema.user.id} = ${schema.thread.userId} AND ${schema.thread.createdAt} >= NOW() - INTERVAL '7 days'`,
      )
      .groupBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 604800)`,
      )
      .orderBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 604800)`,
      ),
    // Get all users broken down by age (months since first thread) with active/inactive status for MAU
    db
      .select({
        monthsAgo: sql<number>`
          FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 2592000)::int
        `.as("months_ago"),
        totalUsers: countDistinct(schema.user.id),
        activeUsers: sql<number>`
          COUNT(DISTINCT CASE
            WHEN recent_thread.user_id IS NOT NULL
            THEN ${schema.user.id}
          END)::int
        `.as("active_users"),
      })
      .from(schema.user)
      .innerJoin(
        db
          .select({
            userId: schema.thread.userId,
            createdAt: sql<Date>`MIN(${schema.thread.createdAt})`.as(
              "created_at",
            ),
          })
          .from(schema.thread)
          .groupBy(schema.thread.userId)
          .as("first_thread"),
        eq(schema.user.id, sql`first_thread.user_id`),
      )
      .leftJoin(
        db
          .selectDistinct({
            userId: schema.thread.userId,
          })
          .from(schema.thread)
          .where(sql`${schema.thread.createdAt} >= NOW() - INTERVAL '30 days'`)
          .as("recent_thread"),
        eq(schema.user.id, sql`recent_thread.user_id`),
      )
      .groupBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 2592000)`,
      )
      .orderBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 2592000)`,
      ),
    // Get only monthly active users broken down by age (for the MAU chart)
    db
      .select({
        monthsAgo: sql<number>`
          FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 2592000)::int
        `.as("months_ago"),
        count: countDistinct(schema.user.id),
      })
      .from(schema.user)
      .innerJoin(
        db
          .select({
            userId: schema.thread.userId,
            createdAt: sql<Date>`MIN(${schema.thread.createdAt})`.as(
              "created_at",
            ),
          })
          .from(schema.thread)
          .groupBy(schema.thread.userId)
          .as("first_thread"),
        eq(schema.user.id, sql`first_thread.user_id`),
      )
      .innerJoin(
        schema.thread,
        sql`${schema.user.id} = ${schema.thread.userId} AND ${schema.thread.createdAt} >= NOW() - INTERVAL '30 days'`,
      )
      .groupBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 2592000)`,
      )
      .orderBy(
        sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - first_thread.created_at)) / 2592000)`,
      ),
  ]);

  const usersData = await getUserListForAdminPage(
    usersWithRecentThread.map((row) => row.user),
  );
  return (
    <AdminUsersList
      totalUsers={totalUsers[0]?.count ?? 0}
      totalUsersWithThreads={totalUsersWithThreads[0]?.count ?? 0}
      totalUsersWithOnboarding={totalUsersWithOnboarding[0]?.count ?? 0}
      weeklyActiveUsers={weeklyActiveUsers[0]?.count ?? 0}
      dailyActiveUsers={dailyActiveUsers[0]?.count ?? 0}
      monthlyActiveUsers={monthlyActiveUsers[0]?.count ?? 0}
      signupsLast24Hours={recentSignupsLast24Hours[0]?.count ?? 0}
      signupsLast7Days={recentSignupsLast7Days[0]?.count ?? 0}
      activeSignupsLast24Hours={recentActiveSignupsLast24Hours[0]?.count ?? 0}
      activeSignupsLast7Days={recentActiveSignupsLast7Days[0]?.count ?? 0}
      totalPreviewOptIn={totalPreviewOptIn[0]?.count ?? 0}
      weeklyActiveUsersByAge={weeklyActiveUsersByAge}
      userRetentionByAge={userRetentionByAge}
      monthlyActiveUsersByAge={monthlyActiveUsersByAge}
      monthlyUserRetentionByAge={monthlyUserRetentionByAge}
      users={usersData}
    />
  );
}
