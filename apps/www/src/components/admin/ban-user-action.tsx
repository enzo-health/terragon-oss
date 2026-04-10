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
import { User } from "@leo/shared";
import { Ban, Unlock } from "lucide-react";

interface BanUserActionProps {
  user: User;
}

export function BanUserAction({ user }: BanUserActionProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [banReason, setBanReason] = useState("");
  const [banDuration, setBanDuration] = useState<"permanent" | "custom">(
    "permanent",
  );
  const [customDays, setCustomDays] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleBan = async () => {
    setIsLoading(true);
    try {
      let banExpiresIn: number | undefined;

      if (banDuration === "custom" && customDays) {
        const days = parseInt(customDays);
        if (isNaN(days) || days <= 0) {
          toast.error("Please enter a valid number of days");
          setIsLoading(false);
          return;
        }
        banExpiresIn = days * 24 * 60 * 60; // Convert days to seconds
      }

      await banUser({
        userId: user.id,
        banReason: banReason || undefined,
        banExpiresIn,
      });

      toast.success("User banned successfully");
      setIsOpen(false);
      router.refresh();
    } catch (error) {
      console.error("Failed to ban user:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to ban user",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnban = async () => {
    setIsLoading(true);
    try {
      await unbanUser(user.id);
      toast.success("User unbanned successfully");
      router.refresh();
    } catch (error) {
      console.error("Failed to unban user:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to unban user",
      );
    } finally {
      setIsLoading(false);
    }
  };

  if (user.banned) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">
          Banned: {user.banReason || "No reason provided"}
          {user.banExpires && (
            <div className="text-xs">
              Expires: {new Date(user.banExpires).toLocaleString()}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          onClick={handleUnban}
          disabled={isLoading}
          className="flex items-center gap-2"
        >
          <Unlock className="h-4 w-4" />
          {isLoading ? "Unbanning..." : "Unban User"}
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" className="flex items-center gap-2">
          <Ban className="h-4 w-4" />
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
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="banDuration">Ban Duration</Label>
            <Select
              value={banDuration}
              onValueChange={(value: "permanent" | "custom") =>
                setBanDuration(value)
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
          {banDuration === "custom" && (
            <div className="space-y-2">
              <Label htmlFor="customDays">Duration in Days</Label>
              <Input
                id="customDays"
                type="number"
                placeholder="Enter number of days"
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                min="1"
              />
            </div>
          )}
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
            onClick={handleBan}
            disabled={isLoading}
          >
            {isLoading ? "Banning..." : "Ban User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
