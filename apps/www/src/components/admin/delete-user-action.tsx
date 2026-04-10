"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { deleteUser } from "@/server-actions/admin/user";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { User } from "@leo/shared";
import { Trash2 } from "lucide-react";

interface DeleteUserActionProps {
  user: User;
}

export function DeleteUserAction({ user }: DeleteUserActionProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleDelete = async () => {
    if (confirmEmail !== user.email) {
      toast.error("Email does not match");
      return;
    }

    setIsLoading(true);
    try {
      const result = await deleteUser(user.id);

      if (result.success) {
        toast.success("User deleted successfully");
        setIsOpen(false);
        router.push("/internal/admin/user");
      } else {
        toast.error(result.errorMessage);
      }
    } catch (error) {
      console.error("Failed to delete user:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete user",
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Don't allow deleting admins
  if (user.role === "admin") {
    return (
      <span className="text-muted-foreground">Cannot delete admin users</span>
    );
  }

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setConfirmEmail("");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="destructive" className="flex items-center gap-2">
          <Trash2 className="h-4 w-4" />
          Delete User
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete User</DialogTitle>
          <DialogDescription>
            Are you sure you want to permanently delete{" "}
            {user.name || user.email}? This action cannot be undone and will
            delete all associated data including:
            <ul className="list-disc list-inside mt-2 text-sm">
              <li>All threads and chat history</li>
              <li>User settings and preferences</li>
              <li>Automations and environments</li>
              <li>Credentials and API keys</li>
              <li>Usage history and credits</li>
            </ul>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="confirmEmail">
              Type <span className="font-mono font-bold">{user.email}</span> to
              confirm
            </Label>
            <Input
              id="confirmEmail"
              placeholder="Enter user's email to confirm"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setIsOpen(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isLoading || confirmEmail !== user.email}
          >
            {isLoading ? "Deleting..." : "Delete User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
