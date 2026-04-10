import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import * as schema from "@leo/shared/db/schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { BILLABLE_EVENT_TYPES } from "@leo/shared/model/credits";
import { getUserListForAdminPage } from "@/server-lib/admin";
import { TopUsersTable } from "./top-users-table";
import { formatUsdFromCents } from "@/lib/currency";

const PROVIDER_LABELS: Partial<
  Record<(typeof BILLABLE_EVENT_TYPES)[number], string>
> = {
  billable_openai_usd: "OpenAI",
  billable_anthropic_usd: "Anthropic",
  billable_openrouter_usd: "OpenRouter",
  billable_google_usd: "Google",
};

export default async function AdminCreditsUsagePage() {
  await getAdminUserOrThrow();

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [
    overallRow,
    totalsByProvider,
    last7DaysRow,
    last7DaysByProvider,
    topUsersLast7Days,
  ] = await Promise.all([
    // All-time totals
    db
      .select({
        totalCents: sql<number>`COALESCE(SUM(${schema.usageEvents.value} * 100)::bigint, 0)`,
      })
      .from(schema.usageEvents)
      .where(inArray(schema.usageEvents.eventType, BILLABLE_EVENT_TYPES)),
    db
      .select({
        eventType: schema.usageEvents.eventType,
        totalCents: sql<number>`COALESCE(SUM(${schema.usageEvents.value} * 100)::bigint, 0)`,
      })
      .from(schema.usageEvents)
      .where(inArray(schema.usageEvents.eventType, BILLABLE_EVENT_TYPES))
      .groupBy(schema.usageEvents.eventType),

    // Last 7 days totals
    db
      .select({
        totalCents: sql<number>`COALESCE(SUM(${schema.usageEvents.value} * 100)::bigint, 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          inArray(schema.usageEvents.eventType, BILLABLE_EVENT_TYPES),
          gte(schema.usageEvents.createdAt, sevenDaysAgo),
        ),
      ),
    db
      .select({
        eventType: schema.usageEvents.eventType,
        totalCents: sql<number>`COALESCE(SUM(${schema.usageEvents.value} * 100)::bigint, 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          inArray(schema.usageEvents.eventType, BILLABLE_EVENT_TYPES),
          gte(schema.usageEvents.createdAt, sevenDaysAgo),
        ),
      )
      .groupBy(schema.usageEvents.eventType),

    // Top 20 users from last 7 days usage events
    db
      .select({
        user: schema.user,
        totalCents: sql<number>`COALESCE(SUM(${schema.usageEvents.value} * 100)::bigint, 0)`,
        eventTypes: sql<
          string[]
        >`ARRAY_AGG(DISTINCT ${schema.usageEvents.eventType})`,
      })
      .from(schema.usageEvents)
      .innerJoin(schema.user, eq(schema.usageEvents.userId, schema.user.id))
      .where(
        and(
          inArray(schema.usageEvents.eventType, BILLABLE_EVENT_TYPES),
          gte(schema.usageEvents.createdAt, sevenDaysAgo),
        ),
      )
      .groupBy(schema.usageEvents.userId, schema.user.id)
      .orderBy(sql`SUM(${schema.usageEvents.value}) DESC`)
      .limit(20),
  ]);

  const totalSpentCents = Number(overallRow[0]?.totalCents ?? 0);
  const providerRows = totalsByProvider
    .map((row) => ({
      label:
        PROVIDER_LABELS[
          row.eventType as (typeof BILLABLE_EVENT_TYPES)[number]
        ] ?? row.eventType,
      cents: Number(row.totalCents ?? 0),
    }))
    .sort((a, b) => b.cents - a.cents);

  const last7DaysSpentCents = Number(last7DaysRow[0]?.totalCents ?? 0);
  const last7DaysProviderRows = last7DaysByProvider
    .map((row) => ({
      label:
        PROVIDER_LABELS[
          row.eventType as (typeof BILLABLE_EVENT_TYPES)[number]
        ] ?? row.eventType,
      cents: Number(row.totalCents ?? 0),
    }))
    .sort((a, b) => b.cents - a.cents);

  const topCreditsUsers = await getUserListForAdminPage(
    topUsersLast7Days.map((user) => {
      return {
        ...user.user,
        totalCents: Number(user.totalCents ?? 0),
        eventTypes: user.eventTypes as (typeof BILLABLE_EVENT_TYPES)[number][],
      };
    }),
  );
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Internal Credits Usage</h1>
        <p className="text-muted-foreground text-sm">
          Aggregate cost of billable usage covered by Leo&apos;s internal
          credits across all accounts.
        </p>
      </div>

      {/* All-time stats */}
      <div>
        <h2 className="text-base font-medium mb-2">All-Time Usage</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <div className="border rounded-lg p-3 md:col-span-2 lg:col-span-1">
            <div className="text-xs text-muted-foreground mb-1">
              Total Credits Spent
            </div>
            <div className="text-2xl font-semibold">
              {formatUsdFromCents(totalSpentCents)}
            </div>
            <div className="text-xs text-muted-foreground">
              Lifetime internal credits consumed by all users
            </div>
          </div>

          <div className="border rounded-lg p-3 md:col-span-2 lg:col-span-2">
            <div className="text-xs text-muted-foreground mb-2">
              Provider Breakdown
            </div>
            {providerRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No internal credit usage recorded yet.
              </p>
            ) : (
              <div className="space-y-2">
                {providerRows.map((provider) => {
                  const percentage =
                    totalSpentCents > 0
                      ? Math.round((provider.cents / totalSpentCents) * 1000) /
                        10
                      : 0;

                  return (
                    <div
                      key={provider.label}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <div className="text-sm font-medium">
                          {provider.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {percentage}% of total spend
                        </div>
                      </div>
                      <div className="text-sm font-medium">
                        {formatUsdFromCents(provider.cents)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Last 7 days stats */}
      <div>
        <h2 className="text-base font-medium mb-2">Past 7 Days Usage</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <div className="border rounded-lg p-3 md:col-span-2 lg:col-span-1">
            <div className="text-xs text-muted-foreground mb-1">
              Total Credits Spent
            </div>
            <div className="text-2xl font-semibold">
              {formatUsdFromCents(last7DaysSpentCents)}
            </div>
            <div className="text-xs text-muted-foreground">
              Internal credits consumed in the last 7 days
            </div>
          </div>

          <div className="border rounded-lg p-3 md:col-span-2 lg:col-span-2">
            <div className="text-xs text-muted-foreground mb-2">
              Provider Breakdown
            </div>
            {last7DaysProviderRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No credit usage recorded in the last 7 days.
              </p>
            ) : (
              <div className="space-y-2">
                {last7DaysProviderRows.map((provider) => {
                  const percentage =
                    last7DaysSpentCents > 0
                      ? Math.round(
                          (provider.cents / last7DaysSpentCents) * 1000,
                        ) / 10
                      : 0;

                  return (
                    <div
                      key={provider.label}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <div className="text-sm font-medium">
                          {provider.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {percentage}% of 7-day spend
                        </div>
                      </div>
                      <div className="text-sm font-medium">
                        {formatUsdFromCents(provider.cents)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Top users */}
      <div>
        <h2 className="text-base font-medium mb-2">
          Top 20 Users by Credit Usage (Last 7 Days)
        </h2>
        {topCreditsUsers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No user credit usage recorded in the last 7 days.
          </p>
        ) : (
          <TopUsersTable data={topCreditsUsers} />
        )}
      </div>
    </div>
  );
}
