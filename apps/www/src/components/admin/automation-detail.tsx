"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Automation } from "@leo/shared/db/types";
import { cronToHumanReadable } from "@leo/shared/automations/cron";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { SingleEntityTable } from "./single-entity-table";

interface AutomationWithUser extends Automation {
  user: {
    id: string;
    name: string;
    email: string;
  } | null;
}

export function AdminAutomationDetail({
  automation,
}: {
  automation: AutomationWithUser;
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Automations", href: "/internal/admin/automations" },
    { label: automation.id },
  ]);
  const triggerConfig = automation.triggerConfig as any;
  const actionConfig = automation.action.config as any;

  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="flex flex-col gap-2">
        <SingleEntityTable
          entity={automation}
          rowKeys={[
            "id",
            "name",
            "description",
            "owner",
            "enabled",
            "triggerType",
            "schedule",
            "timezone",
            "actionType",
            "repoFullName",
            "branchName",
            "message",
            "model",
            "runCount",
            "lastRunAt",
            "createdAt",
            "updatedAt",
            "disableGitCheckpointing",
            "skipSetup",
            "triggerConfig",
            "action",
          ]}
          getLabel={(key) => {
            const labelMap: Record<string, string> = {
              repoFullName: "repository",
              branchName: "branch",
              triggerConfig: "Trigger Configuration",
              action: "Action Configuration",
            };
            return labelMap[key] ?? key;
          }}
          renderKey={(key) => {
            if (key === "owner") {
              return automation.user ? (
                {
                  type: "link",
                  href: `/internal/admin/user/${automation.user.id}`,
                  label: `${automation.user.name} (${automation.user.email})`,
                }
              ) : (
                <span className="text-muted-foreground">Unknown user</span>
              );
            }
            if (key === "schedule") {
              if (
                automation.triggerType !== "schedule" ||
                !triggerConfig?.cron
              ) {
                return { type: "hidden" };
              }
              return (
                <div className="space-y-1">
                  <span className="font-mono text-sm">
                    {triggerConfig.cron}
                  </span>
                  <p className="text-sm text-muted-foreground">
                    {cronToHumanReadable(triggerConfig.cron)}
                  </p>
                </div>
              );
            }
            if (key === "timezone") {
              if (
                automation.triggerType !== "schedule" ||
                !triggerConfig?.timezone
              ) {
                return { type: "hidden" };
              }
              return triggerConfig.timezone;
            }
            if (key === "actionType") {
              return automation.action.type;
            }
            if (key === "message") {
              if (
                automation.action.type !== "user_message" ||
                !actionConfig.message
              ) {
                return "-";
              }
              return convertToPlainText({ message: actionConfig.message });
            }
            if (key === "model") {
              if (
                automation.action.type !== "user_message" ||
                !actionConfig.message
              ) {
                return { type: "hidden" };
              }
              return actionConfig.message?.model || "default";
            }
            return undefined;
          }}
        />
      </div>
    </div>
  );
}
