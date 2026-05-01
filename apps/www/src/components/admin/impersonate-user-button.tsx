"use client";

import { useState } from "react";
import { UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";

export function ImpersonateUserButton({ userId }: { userId: string }) {
  const [isLoading, setIsLoading] = useState(false);

  const handleImpersonate = async () => {
    try {
      setIsLoading(true);
      await authClient.admin.impersonateUser({
        userId,
      });
      // We want a full page refresh here.
      window.location.href = `/`;
    } catch (error) {
      console.error("Failed to impersonate user:", error);
      toast.error("Failed to impersonate user");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleImpersonate}
      disabled={isLoading}
      variant="outline"
      className="rounded-full bg-warning/10 text-warning border-warning/30 hover:bg-warning/15 hover:text-warning gap-2"
    >
      <UserCog className="h-4 w-4" />
      {isLoading ? "Impersonating..." : "Impersonate"}
    </Button>
  );
}
