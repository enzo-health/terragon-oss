"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { changeUserRole } from "@/server-actions/admin/user";
import { User } from "@leo/shared";
import { toast } from "sonner";

export function UserRoleSelector({ user }: { user: User }) {
  const router = useRouter();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingRole, setPendingRole] = useState<"admin" | "user" | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const handleRoleChange = async (value: "admin" | "user") => {
    // If changing to admin, show confirmation dialog
    if (value === "admin" && user.role !== "admin") {
      setPendingRole(value);
      setShowConfirmDialog(true);
      return;
    }

    // Otherwise, proceed with the change
    await updateUserRole(value);
  };

  const updateUserRole = async (role: "admin" | "user") => {
    setIsUpdating(true);
    try {
      await changeUserRole(user.id, role);
      router.refresh();
      toast.success("User role updated");
    } catch (error) {
      console.error(error);
      toast.error(`Failed to update user role`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleConfirm = async () => {
    if (pendingRole) {
      await updateUserRole(pendingRole);
    }
    setShowConfirmDialog(false);
    setPendingRole(null);
  };

  return (
    <div>
      <Select
        value={user.role ?? "user"}
        onValueChange={handleRoleChange}
        disabled={isUpdating}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a role" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="user">User</SelectItem>
        </SelectContent>
      </Select>

      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Admin Role</DialogTitle>
            <DialogDescription>
              Are you sure you want to make {user.email} an admin? This will
              grant them full access to the admin panel and all administrative
              functions.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowConfirmDialog(false);
                setPendingRole(null);
              }}
              disabled={isUpdating}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={isUpdating}>
              {isUpdating ? "Updating..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
