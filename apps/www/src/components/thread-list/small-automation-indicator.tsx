"use client";

import { WorkflowIcon } from "lucide-react";
import Link from "next/link";
import React from "react";

const stopAutomationLinkPropagation = (event: React.MouseEvent) => {
  event.stopPropagation();
};

export function SmallAutomationIndicator({
  automationId,
}: {
  automationId: string;
}) {
  return (
    <Link
      href={`/automations/${automationId}`}
      prefetch={true}
      onClick={stopAutomationLinkPropagation}
      className="cursor-pointer"
      title="Automation"
    >
      <WorkflowIcon className="size-4 text-muted-foreground" />
    </Link>
  );
}
