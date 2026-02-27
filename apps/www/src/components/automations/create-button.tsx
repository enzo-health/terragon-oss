"use client";

import { Button } from "../ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AutomationEditorDialogContent } from "./form";
import { useRouter } from "next/navigation";
import {
  AutomationTrigger,
  AutomationAction,
} from "@terragon/shared/automations";
import { useCreateAutomationMutation } from "@/queries/automation-mutations";

export interface CreateAutomationInitialValues {
  name?: string;
  repoFullName?: string;
  branchName?: string;
  disableGitCheckpointing?: boolean;
  skipSetup?: boolean;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
}

export function CreateAutomationButton({
  isOpen,
  setIsOpen,
  initialValues,
  setInitialValues,
}: {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  initialValues: CreateAutomationInitialValues | null;
  setInitialValues: (v: CreateAutomationInitialValues | null) => void;
}) {
  const createAutomationMutation = useCreateAutomationMutation();
  const router = useRouter();
  const handleClick = () => {
    setInitialValues(null);
    setIsOpen(true);
  };

  return (
    <>
      <Button size="sm" className="h-7" onClick={handleClick}>
        Create Automation
      </Button>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <AutomationEditorDialogContent
          automation={null}
          title="Create Automation"
          ctaLabel="Create"
          initialValues={initialValues}
          onSubmit={async (values) => {
            try {
              await createAutomationMutation.mutateAsync({
                automation: {
                  name: values.name,
                  repoFullName: values.repoFullName,
                  branchName: values.branchName,
                  triggerType: values.trigger.type,
                  triggerConfig: values.trigger.config,
                  action: values.action,
                  disableGitCheckpointing: !!values.disableGitCheckpointing,
                  skipSetup: !!values.skipSetup,
                },
              });
              router.refresh();
              setIsOpen(false);
              setInitialValues(null);
            } catch (error) {
              console.error(error);
            }
          }}
        />
      </Dialog>
    </>
  );
}
