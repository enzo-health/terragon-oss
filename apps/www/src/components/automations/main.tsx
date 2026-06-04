"use client";

import { AlertCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import {
  automationQueryOptions,
  hasReachedLimitOfAutomationsQueryOptions,
} from "@/queries/automation-queries";
import { Automation } from "@terragon/shared";
import { useState } from "react";
import {
  CreateAutomationButton,
  CreateAutomationInitialValues,
} from "./create-button";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { AutomationItem } from "./item";
import { EditAutomationDialog } from "./edit-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePageHeader } from "@/contexts/page-header";
import { createPortal } from "react-dom";
import { RecommendedAutomations } from "./recommended-automations";
import { type RecommendedAutomation } from "./recommended-automation-templates";
import { AutomationTrigger } from "@terragon/shared/automations";
import { useAtomValue } from "jotai";
import {
  selectedModelAtom,
  selectedRepoAtom,
  selectedBranchAtom,
} from "@/atoms/user-flags";
import { publicDocsUrl } from "@terragon/env/next-public";

export function Automations() {
  const { headerActionContainer } = usePageHeader();
  const [isOpen, setIsOpen] = useState(false);
  const [initialValues, setInitialValues] =
    useState<CreateAutomationInitialValues | null>(null);
  const selectedModel = useAtomValue(selectedModelAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const selectedBranch = useAtomValue(selectedBranchAtom);
  return (
    <>
      {headerActionContainer &&
        createPortal(
          <CreateAutomationButton
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            initialValues={initialValues}
            setInitialValues={setInitialValues}
          />,
          headerActionContainer,
        )}
      <AutomationsList
        onRecommendedAutomationSelected={(recommendedAutomation) => {
          const initialValues: CreateAutomationInitialValues = {
            name: recommendedAutomation.label,
            repoFullName: selectedRepo || "",
            branchName: selectedBranch || "",
            trigger: {
              type: recommendedAutomation.triggerType,
              config: recommendedAutomation.triggerConfig,
            } as AutomationTrigger,
            action: {
              type: "user_message",
              config: {
                message: {
                  type: "user",
                  model: selectedModel,
                  parts: [{ type: "text", text: recommendedAutomation.prompt }],
                },
              },
            },
          };
          setInitialValues(initialValues);
          setIsOpen(true);
        }}
        onDuplicate={(automation) => {
          const initialValues: CreateAutomationInitialValues = {
            name: `${automation.name} (Copy)`,
            repoFullName: automation.repoFullName,
            branchName: automation.branchName,
            disableGitCheckpointing: automation.disableGitCheckpointing,
            skipSetup: automation.skipSetup,
            trigger: {
              type: automation.triggerType,
              config: automation.triggerConfig,
            } as AutomationTrigger,
            action: automation.action,
          };
          setInitialValues(initialValues);
          setIsOpen(true);
        }}
      />
    </>
  );
}

function AutomationsList({
  onRecommendedAutomationSelected,
  onDuplicate,
}: {
  onRecommendedAutomationSelected: (
    recommendedAutomation: RecommendedAutomation,
  ) => void;
  onDuplicate: (automation: Automation) => void;
}) {
  const {
    data: automations,
    isLoading,
    error,
    refetch,
  } = useQuery(automationQueryOptions());
  const { data: hasReachedLimit, refetch: refetchHasReachedLimit } = useQuery(
    hasReachedLimitOfAutomationsQueryOptions(),
  );
  useRealtimeUser({
    matches: (message) => !!message.data.automationId,
    onMessage: () => {
      refetch();
      refetchHasReachedLimit();
    },
  });
  const [automationToEdit, setAutomationToEdit] = useState<Automation | null>(
    null,
  );
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-lg bg-card shadow-inset-edge animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">
          Error loading automations. Please try again.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      {hasReachedLimit && (
        <Alert className="mb-3 bg-warning/10 text-warning border-none rounded-lg">
          <AlertCircle className="size-4" />
          <AlertDescription className="text-warning-strong">
            You have reached the active automation limit. To create another,
            disable or delete an existing active automation.
          </AlertDescription>
        </Alert>
      )}
      {automations?.length === 0 && (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-card p-4 shadow-inset-edge">
            <h3 className="text-sm font-semibold mb-1.5">About automations</h3>
            <p className="text-sm text-muted-foreground leading-normal">
              Automations are saved prompts that run automatically in response
              to a trigger. Schedules, GitHub pull requests, issues, and
              mentions are supported.
            </p>
            <Link
              href={`${publicDocsUrl()}/docs/automations`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-coral hover:underline"
            >
              Learn more
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground sticky top-8 bg-canvas z-10 py-1">
              Suggested automations
            </h3>
            <RecommendedAutomations
              onSelect={onRecommendedAutomationSelected}
            />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {automations?.map((automation) => (
          <AutomationItem
            key={automation.id}
            automation={automation}
            onEdit={() => setAutomationToEdit(automation)}
            onDuplicate={onDuplicate}
            verbose={false}
          />
        ))}
      </div>
      <EditAutomationDialog
        automation={automationToEdit}
        onClose={() => setAutomationToEdit(null)}
      />
    </>
  );
}
