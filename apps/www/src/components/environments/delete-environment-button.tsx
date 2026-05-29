"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { deleteEnvironment } from "@/server-actions/delete-environment";
import { toast } from "sonner";

interface DeleteEnvironmentButtonProps {
  environmentId: string;
  repoFullName: string;
}

export function DeleteEnvironmentButton({
  environmentId,
  repoFullName,
}: DeleteEnvironmentButtonProps) {
  const { push, refresh } = useRouter();
  const [showDialog, setShowDialog] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleDelete = () => {
    startTransition(async () => {
      try {
        await deleteEnvironment({ environmentId });
        toast.success(`Environment for ${repoFullName} deleted`);
        setShowDialog(false);
        push("/environments");
        refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to delete environment",
        );
      }
    });
  };

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setShowDialog(true)}
        disabled={isPending}
      >
        Delete Environment
      </Button>
      <DeleteConfirmationDialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!isPending) {
            setShowDialog(open);
          }
        }}
        onConfirm={handleDelete}
        title="Delete Environment"
        description={`Are you sure you want to delete the environment for ${repoFullName}? This action cannot be undone.`}
        confirmText={isPending ? "Deleting..." : "Delete"}
        isLoading={isPending}
      />
    </>
  );
}
