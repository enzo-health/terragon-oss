"use server";

import { getThreadsAndPRsStats } from "@leo/shared/model/threads";
import { validateTimezone } from "@leo/shared/utils/timezone";
import { getUserInfoOrNull, userOnlyAction } from "@/lib/auth-server";
import { addDays, format, subDays, set as setDateValues } from "date-fns";
import { db } from "@/lib/db";
import { tz } from "@date-fns/tz";

export interface UsageStatsSummary {
  totalThreadsCreated: number;
  totalPRsMerged: number;
}

export interface DailyUsageStats {
  date: string;
  threadsCreated: number;
  prsMerged: number;
}

const defaultStats: Omit<DailyUsageStats, "date"> = {
  threadsCreated: 0,
  prsMerged: 0,
};

export const getUsageStats = userOnlyAction(
  async function getUsageStats(
    userId: string,
    {
      numDays,
      timezone,
    }: {
      numDays: number;
      timezone: string;
    },
  ) {
    console.log("getUsageStats", { numDays, timezone });
    const userInfo = await getUserInfoOrNull();
    if (!userInfo) {
      throw new Error("Unauthorized");
    }
    if (numDays > 30) throw new Error("Max range is 30 days");
    if (numDays < 1) throw new Error("Min range is 1 day");
    const validatedTimezone = validateTimezone(timezone);
    const end = setDateValues(new Date(), {}, { in: tz(validatedTimezone) });
    const start = setDateValues(
      subDays(end, numDays - 1, {
        in: tz(validatedTimezone),
      }),
      { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 },
    );
    const threadsAndPRsData = await getThreadsAndPRsStats({
      db,
      userId,
      startDate: start,
      endDate: end,
      timezone: validatedTimezone,
    });

    // Transform threads and PRs data into daily stats
    const dailyStatsMap = new Map<string, DailyUsageStats>();

    // Generate all dates in the range
    let currentDate = new Date(start);
    const endTime = end.getTime();
    while (currentDate.getTime() <= endTime) {
      const dateKey = format(currentDate, "yyyy-MM-dd");
      if (!dailyStatsMap.has(dateKey)) {
        dailyStatsMap.set(dateKey, { ...defaultStats, date: dateKey });
      }
      currentDate = addDays(currentDate, 1);
    }
    let totalThreadsCreated = 0;
    let totalPRsMerged = 0;
    // Add threads and PRs data
    for (const data of threadsAndPRsData.threadsCreated) {
      if (!dailyStatsMap.has(data.date)) {
        continue;
      }
      const stats = dailyStatsMap.get(data.date)!;
      stats.threadsCreated = data.threadsCreated;
      totalThreadsCreated += data.threadsCreated;
    }
    for (const data of threadsAndPRsData.prsMerged) {
      if (!dailyStatsMap.has(data.date)) {
        continue;
      }
      const stats = dailyStatsMap.get(data.date)!;
      stats.prsMerged = data.prsMerged;
      totalPRsMerged += data.prsMerged;
    }

    // Convert map to sorted array (newest first)
    const dailyStats: DailyUsageStats[] = Array.from(
      dailyStatsMap.values(),
    ).sort((a, b) => b.date.localeCompare(a.date));
    return {
      dailyStats,
      summary: {
        totalThreadsCreated,
        totalPRsMerged,
      },
    };
  },
  { defaultErrorMessage: "Failed to get usage stats" },
);
