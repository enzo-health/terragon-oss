import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AdminAutomationsList } from "@/components/admin/automations-list";
import {
  getAllAutomationsForAdmin,
  getAutomationStatsForAdmin,
} from "@leo/shared/model/automations";
import {
  AutomationTriggerType,
  triggerTypeLabels,
} from "@leo/shared/automations";

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
      <div className="mb-4 flex flex-col gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Total Automations:</span>
          <span className="font-semibold">{stats.totalAutomations}</span>
        </div>
        <div className="flex gap-0 border w-fit rounded-md">
          {stats.triggerTypeStats.map((stat) => (
            <div className="flex flex-col items-center gap-2 border-r px-2 py-1">
              <span className="text-muted-foreground">
                {triggerTypeLabels[stat.triggerType as AutomationTriggerType]}
              </span>
              <span className="font-semibold">{stat.count}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Users with Automations:</span>
          <span className="font-semibold">{stats.totalUniqueUsers}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            Number of automations runs last week:
          </span>
          <span className="font-semibold">{stats.totalRunsLastWeek}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            Number of users with automations that ran last week:
          </span>
          <span className="font-semibold">{stats.uniqueUsersLastWeek}</span>
        </div>
      </div>
      <AdminAutomationsList
        triggerType={params.triggerType}
        automations={automations}
      />
    </>
  );
}
