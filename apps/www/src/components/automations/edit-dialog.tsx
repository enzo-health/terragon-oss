"use client";

import { Automation } from "@leo/shared";
import { useEditAutomationMutation } from "@/queries/automation-mutations";
import { Dialog } from "@/components/ui/dialog";
import { AutomationEditorDialogContent } from "./form";

export function EditAutomationDialog({
  automation,
  onClose,
}: {
  automation: Automation | null;
  onClose: () => void;
}) {
  const editMutation = useEditAutomationMutation();
  return (
    <Dialog open={!!automation} onOpenChange={onClose}>
      <AutomationEditorDialogContent
        title="Edit Automation"
        automation={automation}
        initialValues={null}
        ctaLabel="Save"
        onSubmit={async (values) => {
          if (!automation) {
            throw new Error("Automation not found");
          }
          try {
            await editMutation.mutateAsync({
              automationId: automation.id,
              updates: {
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
            onClose();
          } catch (error) {
            throw error;
          }
        }}
      />
    </Dialog>
  );
}
