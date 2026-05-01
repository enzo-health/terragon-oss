import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AdminAutomationsList } from "@/components/admin/automations-list";
import {
  getAllAutomationsForAdmin,
  getAutomationStatsForAdmin,
} from "@terragon/shared/model/automations";
import {
  AutomationTriggerType,
  triggerTypeLabels,
} from "@terragon/shared/automations";

export default async function AdminAutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    triggerType?: AutomationTriggerType;
  }>;
}) {
  await getAdminUserOrThrow();
  const params = await searchParams;
  const [automations, stats] = await Promise.all([
    getAllAutomationsForAdmin({
      db,
      limit: 100,
      triggerType: params.triggerType,
    }),
    getAutomationStatsForAdmin({ db }),
  ]);
  return (
    <>
      <div className="mb-6 flex flex-col gap-5 text-sm">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-4 border-b border-hairline-strong/60 py-1.5">
            <dt className="text-muted-foreground">Total automations</dt>
            <dd className="font-medium tabular-nums">
              {stats.totalAutomations}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-b border-hairline-strong/60 py-1.5">
            <dt className="text-muted-foreground">Users with automations</dt>
            <dd className="font-medium tabular-nums">
              {stats.totalUniqueUsers}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-b border-hairline-strong/60 py-1.5">
            <dt className="text-muted-foreground">Runs in last 7 days</dt>
            <dd className="font-medium tabular-nums">
              {stats.totalRunsLastWeek}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-b border-hairline-strong/60 py-1.5">
            <dt className="text-muted-foreground">
              Active users in last 7 days
            </dt>
            <dd className="font-medium tabular-nums">
              {stats.uniqueUsersLastWeek}
            </dd>
          </div>
        </dl>

        <div className="flex w-fit divide-x divide-hairline-strong/60 overflow-hidden rounded-xl border border-hairline-strong/60 bg-card-cream">
          {stats.triggerTypeStats.map((stat) => (
            <div
              key={stat.triggerType}
              className="flex flex-col items-center gap-1 px-4 py-2"
            >
              <span className="text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                {triggerTypeLabels[stat.triggerType as AutomationTriggerType]}
              </span>
              <span className="text-base font-medium tabular-nums">
                {stat.count}
              </span>
            </div>
          ))}
        </div>
      </div>
      <AdminAutomationsList
        triggerType={params.triggerType}
        automations={automations}
      />
    </>
  );
}
