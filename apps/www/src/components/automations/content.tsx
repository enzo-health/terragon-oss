"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { useQuery } from "@tanstack/react-query";
import { BreadcrumbItem } from "@/contexts/page-header";
import { automationDetailQueryOptions } from "@/queries/automation-queries";
import { Loader2 } from "lucide-react";
import { AutomationItem } from "./item";
import { useState } from "react";
import { EditAutomationDialog } from "./edit-dialog";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { ThreadListMain } from "../thread-list/main";

export function AutomationContent({ automationId }: { automationId: string }) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const {
    data: automation,
    isLoading,
    error,
    refetch,
  } = useQuery(automationDetailQueryOptions(automationId));
  usePageBreadcrumbs(
    [
      { label: "Automations", href: "/automations" },
      automation && {
        label: automation.name,
        href: `/automations/${automation.id}`,
      },
    ].filter(Boolean) as BreadcrumbItem[],
  );
  useRealtimeUser({
    matches: (message) => message.data.automationId === automationId,
    onMessage: () => {
      refetch();
    },
  });
  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (error || !automation) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Error loading automation. Please try again.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-6">
        <AutomationItem
          automation={automation}
          onEdit={() => setIsEditDialogOpen(true)}
        />
        <ThreadListMain
          viewFilter="all"
          allowGroupBy={false}
          queryFilters={{ automationId }}
          showSuggestedTasks={false}
          setPromptText={() => {}}
        />
      </div>
      <EditAutomationDialog
        automation={isEditDialogOpen ? automation : null}
        onClose={() => setIsEditDialogOpen(false)}
      />
    </>
  );
}
