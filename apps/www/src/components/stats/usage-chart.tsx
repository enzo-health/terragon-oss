"use client";

import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { DailyUsageStats } from "@/server-actions/stats";
import { parse } from "date-fns";
import { timeZoneAtom } from "@/atoms/user-cookies";
import { useAtomValue } from "jotai";
import { tz } from "@date-fns/tz";

interface UsageChartProps {
  dailyStats: DailyUsageStats[];
}

const threadsChartConfig = {
  threads: {
    label: "Threads",
    color: "var(--coral)",
  },
} satisfies ChartConfig;

const prsChartConfig = {
  prs: {
    label: "PRs",
    color: "var(--info)",
  },
} satisfies ChartConfig;

export function UsageChart({ dailyStats }: UsageChartProps) {
  const timeZone = useAtomValue(timeZoneAtom);
  if (dailyStats.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No activity in this range yet.
      </div>
    );
  }

  // Prepare data for charts
  const chartData = [...dailyStats].reverse().map((day) => {
    return {
      date: format(
        parse(day.date, "yyyy-MM-dd", new Date(), {
          in: tz(timeZone),
        }),
        "MMM d",
      ),
      threads: day.threadsCreated,
      prs: day.prsMerged,
    };
  });

  return (
    <div className="grid gap-x-10 gap-y-8 grid-cols-1 lg:grid-cols-2">
      <section className="space-y-5">
        <header className="flex flex-col gap-0.5">
          <h4 className="text-sm font-medium text-foreground">Tasks created</h4>
          <p className="text-xs text-muted-foreground">
            Per day, in your timezone.
          </p>
        </header>
        <ChartContainer
          config={threadsChartConfig}
          className="h-[200px] w-full [&_.recharts-cartesian-axis-tick_text]:tabular-nums [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground"
        >
          <BarChart data={chartData}>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="var(--hairline-strong)"
            />
            <XAxis
              dataKey="date"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `${value}`}
              domain={[0, (dataMax: number) => Math.max(5, dataMax)]}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => value}
                  formatter={(value) => `${value} threads`}
                />
              }
            />
            <Bar dataKey="threads" fill="var(--color-threads)" radius={4} />
          </BarChart>
        </ChartContainer>
      </section>

      <section className="space-y-5">
        <header className="flex flex-col gap-0.5">
          <h4 className="text-sm font-medium text-foreground">PRs merged</h4>
          <p className="text-xs text-muted-foreground">
            Per day, in your timezone.
          </p>
        </header>
        <ChartContainer
          config={prsChartConfig}
          className="h-[200px] w-full [&_.recharts-cartesian-axis-tick_text]:tabular-nums [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground"
        >
          <BarChart data={chartData}>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="var(--hairline-strong)"
            />
            <XAxis
              dataKey="date"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `${value}`}
              domain={[0, (dataMax: number) => Math.max(5, dataMax)]}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => value}
                  formatter={(value) => `${value} PRs`}
                />
              }
            />
            <Bar dataKey="prs" fill="var(--color-prs)" radius={4} />
          </BarChart>
        </ChartContainer>
      </section>
    </div>
  );
}
