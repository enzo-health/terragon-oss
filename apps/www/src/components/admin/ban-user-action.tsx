"use client";

import { useReducer } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { banUser, unbanUser } from "@/server-actions/admin/user";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { User } from "@terragon/shared";
import { Ban, Unlock } from "lucide-react";

interface BanUserActionProps {
  user: User;
}

type BanUserState = {
  isOpen: boolean;
  banReason: string;
  banDuration: "permanent" | "custom";
  customDays: string;
  isLoading: boolean;
};

type BanUserActionType =
  | { type: "set-open"; isOpen: boolean }
  | { type: "set-ban-reason"; banReason: string }
  | { type: "set-ban-duration"; banDuration: "permanent" | "custom" }
  | { type: "set-custom-days"; customDays: string }
  | { type: "set-loading"; isLoading: boolean };

function banUserReducer(
  state: BanUserState,
  action: BanUserActionType,
): BanUserState {
  switch (action.type) {
    case "set-open":
      return { ...state, isOpen: action.isOpen };
    case "set-ban-reason":
      return { ...state, banReason: action.banReason };
    case "set-ban-duration":
      return { ...state, banDuration: action.banDuration };
    case "set-custom-days":
      return { ...state, customDays: action.customDays };
    case "set-loading":
      return { ...state, isLoading: action.isLoading };
  }
}

export function BanUserAction({ user }: BanUserActionProps) {
  const { refresh } = useRouter();
  const [state, dispatch] = useReducer(banUserReducer, {
    isOpen: false,
    banReason: "",
    banDuration: "permanent",
    customDays: "",
    isLoading: false,
  });

  const handleBan = async () => {
    dispatch({ type: "set-loading", isLoading: true });
    try {
      let banExpiresIn: number | undefined;

      if (state.banDuration === "custom" && state.customDays) {
        const days = parseInt(state.customDays);
        if (isNaN(days) || days <= 0) {
          toast.error("Please enter a valid number of days");
          dispatch({ type: "set-loading", isLoading: false });
          return;
        }
        banExpiresIn = days * 24 * 60 * 60; // Convert days to seconds
      }

      await banUser({
        userId: user.id,
        banReason: state.banReason || undefined,
        banExpiresIn,
      });

      toast.success("User banned successfully");
      dispatch({ type: "set-open", isOpen: false });
      refresh();
      dispatch({ type: "set-loading", isLoading: false });
    } catch (error) {
      console.error("Failed to ban user:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to ban user",
      );
      dispatch({ type: "set-loading", isLoading: false });
    }
  };

  const handleUnban = async () => {
    dispatch({ type: "set-loading", isLoading: true });
    try {
      await unbanUser(user.id);
      toast.success("User unbanned successfully");
      refresh();
      dispatch({ type: "set-loading", isLoading: false });
    } catch (error) {
      console.error("Failed to unban user:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to unban user",
      );
      dispatch({ type: "set-loading", isLoading: false });
    }
  };

  if (user.banned) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">
          Banned: {user.banReason || "No reason provided"}
          {user.banExpires && (
            <div className="text-xs tabular-nums">
              Expires: {new Date(user.banExpires).toLocaleString()}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          onClick={handleUnban}
          disabled={state.isLoading}
          className="flex items-center gap-2 rounded-full"
        >
          <Unlock className="size-4" />
          {state.isLoading ? "Unbanning..." : "Unban User"}
        </Button>
      </div>
    );
  }

  return (
    <Dialog
      open={state.isOpen}
      onOpenChange={(isOpen) => dispatch({ type: "set-open", isOpen })}
    >
      <DialogTrigger asChild>
        <Button
          variant="destructive"
          className="flex items-center gap-2 rounded-full"
        >
          <Ban className="size-4" />
          Ban User
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ban User</DialogTitle>
          <DialogDescription>
            Are you sure you want to ban {user.name || user.email}? They will
            not be able to access the application.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="banReason">Ban Reason (Optional)</Label>
            <Textarea
              id="banReason"
              placeholder="Enter the reason for banning this user..."
              value={state.banReason}
              onChange={(e) =>
                dispatch({
                  type: "set-ban-reason",
                  banReason: e.target.value,
                })
              }
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="banDuration">Ban Duration</Label>
            <Select
              value={state.banDuration}
              onValueChange={(value: "permanent" | "custom") =>
                dispatch({ type: "set-ban-duration", banDuration: value })
              }
            >
              <SelectTrigger id="banDuration">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="permanent">Permanent</SelectItem>
                <SelectItem value="custom">Custom Duration</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {state.banDuration === "custom" && (
            <div className="space-y-2">
              <Label htmlFor="customDays">Duration in Days</Label>
              <Input
                id="customDays"
                type="number"
                placeholder="Enter number of days"
                value={state.customDays}
                onChange={(e) =>
                  dispatch({
                    type: "set-custom-days",
                    customDays: e.target.value,
                  })
                }
                min="1"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => dispatch({ type: "set-open", isOpen: false })}
            disabled={state.isLoading}
            className="rounded-full"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleBan}
            disabled={state.isLoading}
            className="rounded-full"
          >
            {state.isLoading ? "Banning..." : "Ban User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
