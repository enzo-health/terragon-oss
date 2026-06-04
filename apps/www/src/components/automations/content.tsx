"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { useQuery } from "@tanstack/react-query";
import { BreadcrumbItem } from "@/contexts/page-header";
import { automationDetailQueryOptions } from "@/queries/automation-queries";
import { Button } from "@/components/ui/button";
import { AutomationItem } from "./item";
import { useState } from "react";
import { EditAutomationDialog } from "./edit-dialog";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { ThreadListMain } from "../thread-list/main";

const noopSetPromptText = () => {};

export function AutomationContent({ automationId }: { automationId: string }) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const openEditDialog = () => {
    setIsEditDialogOpen(true);
  };
  const closeEditDialog = () => {
    setIsEditDialogOpen(false);
  };
  const threadListQueryFilters = { automationId };
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
      <div className="flex flex-col gap-6">
        <div className="h-24 rounded-lg bg-card shadow-inset-edge animate-pulse" />
        <div className="h-9 w-40 rounded-md bg-muted animate-pulse" />
      </div>
    );
  }
  if (error || !automation) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">
          Error loading automation. Please try again.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-6">
        <AutomationItem automation={automation} onEdit={openEditDialog} />
        <ThreadListMain
          viewFilter="all"
          allowGroupBy={false}
          queryFilters={threadListQueryFilters}
          showSuggestedTasks={false}
          setPromptText={noopSetPromptText}
        />
      </div>
      <EditAutomationDialog
        automation={isEditDialogOpen ? automation : null}
        onClose={closeEditDialog}
      />
    </>
  );
}
