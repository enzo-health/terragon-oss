"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  removeUserFeatureFlagOverrideAction,
  setUserFeatureFlagOverrideAction,
  setGlobalFeatureFlagOverrideAction,
} from "@/server-actions/admin/feature-flag";
import { toast } from "sonner";
import { useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";

export function UserFeatureFlagToggle({
  userId,
  flagName,
  value,
}: {
  userId: string;
  flagName: string;
  value: boolean | null;
}) {
  const router = useRouter();

  const handleValueChange = async (newValue: string) => {
    try {
      let parsedValue: boolean | null;
      if (newValue === "true") {
        parsedValue = true;
      } else if (newValue === "false") {
        parsedValue = false;
      } else {
        parsedValue = null;
      }
      if (parsedValue === null) {
        await removeUserFeatureFlagOverrideAction({ userId, flagName });
      } else {
        await setUserFeatureFlagOverrideAction({
          userId,
          flagName,
          value: parsedValue,
        });
      }
      router.refresh();
      toast.success("Feature flag Override updated");
    } catch (error) {
      console.error(error);
      toast.error(`Failed to update feature flag override`);
    }
  };

  return (
    <div className="flex items-center gap-2 font-mono tabular-nums">
      <Select
        value={value?.toString() ?? "null"}
        onValueChange={handleValueChange}
      >
        <SelectTrigger className="w-[110px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
          <SelectItem value="null">null</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function GlobalFeatureFlagToggle({
  flagName,
  value,
}: {
  flagName: string;
  value: boolean | null;
}) {
  const router = useRouter();
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleValueChange = (newValue: string) => {
    // Show confirmation dialog before changing
    setPendingValue(newValue);
    setConfirmDialogOpen(true);
  };

  const handleConfirm = async () => {
    if (pendingValue === null) return;

    setIsLoading(true);
    try {
      let parsedValue: boolean | null;
      if (pendingValue === "true") {
        parsedValue = true;
      } else if (pendingValue === "false") {
        parsedValue = false;
      } else {
        parsedValue = null;
      }
      await setGlobalFeatureFlagOverrideAction({
        flagName,
        value: parsedValue,
      });
      router.refresh();
      toast.success("Global feature flag override updated");
      setConfirmDialogOpen(false);
      setPendingValue(null);
    } catch (error) {
      console.error(error);
      toast.error(`Failed to update global feature flag override`);
    } finally {
      setIsLoading(false);
    }
  };

  const getConfirmationMessage = () => {
    if (pendingValue === null) return "";

    const newValue =
      pendingValue === "true"
        ? "true"
        : pendingValue === "false"
          ? "false"
          : "null";
    return `Are you sure you want to change the global override for "${flagName}" to ${newValue}? This will affect all users who don't have a specific override.`;
  };

  return (
    <>
      <div className="flex items-center gap-2 font-mono tabular-nums">
        <Select
          value={value?.toString() ?? "null"}
          onValueChange={handleValueChange}
        >
          <SelectTrigger className="w-[110px] !border-warning/60 !ring-warning/30">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
            <SelectItem value="null">null</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DeleteConfirmationDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={handleConfirm}
        title="Confirm global feature flag change"
        description={getConfirmationMessage()}
        confirmText="Confirm"
        cancelText="Cancel"
        isLoading={isLoading}
      />
    </>
  );
}
